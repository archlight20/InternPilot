/**
 * Candidate Analytics Utility - InternPilot
 * Computes deep candidate analytics, application funnel, timeline trends,
 * domain/sector breakdowns, and data-driven insights.
 */

const { calculateProfileCompletion } = require('./profileCompletion');

const FUNNEL_STAGES = [
    { key: 'applied', label: 'Applied', color: 'indigo', icon: 'ph-paper-plane-tilt' },
    { key: 'under_review', label: 'Under Review', color: 'sky', icon: 'ph-magnifying-glass' },
    { key: 'shortlisted', label: 'Shortlisted', color: 'violet', icon: 'ph-star' },
    { key: 'interview', label: 'Interview Scheduled', color: 'amber', icon: 'ph-calendar-check' },
    { key: 'offered', label: 'Offered / Placed', color: 'emerald', icon: 'ph-handshake' }
];

function normalizeStatus(value) {
    return String(value || 'Submitted').trim().toLowerCase().replace(/[_-]/g, ' ');
}

function parseRange(queryRange) {
    if (queryRange === 'all') return 'all';
    const num = parseInt(queryRange, 10);
    if ([7, 30, 90].includes(num)) return num;
    return 30; // default 30 days
}

function getTimeWindows(range) {
    const now = new Date();
    if (range === 'all') {
        return { currentStart: new Date(0), prevStart: new Date(0), now };
    }
    const days = Number(range);
    const currentStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const prevStart = new Date(now.getTime() - 2 * days * 24 * 60 * 60 * 1000);
    return { currentStart, prevStart, now, days };
}

function percentageChange(current, previous) {
    if (!previous || previous === 0) {
        return current > 0 ? 100 : 0;
    }
    return Math.round(((current - previous) / previous) * 100);
}

function hasReachedStage(app, stageKey) {
    const norm = normalizeStatus(app.status);
    const historyStatuses = Array.isArray(app.statusHistory)
        ? app.statusHistory.map(h => normalizeStatus(h.status))
        : [];

    switch (stageKey) {
        case 'applied':
            return true;
        case 'under_review':
            return (
                ['under review', 'shortlisted', 'interview', 'hired', 'accepted', 'offer declined'].includes(norm) ||
                historyStatuses.some(s => ['under review', 'shortlisted', 'interview', 'hired', 'accepted'].includes(s))
            );
        case 'shortlisted':
            return (
                ['shortlisted', 'interview', 'hired', 'accepted', 'offer declined'].includes(norm) ||
                historyStatuses.some(s => ['shortlisted', 'interview', 'hired', 'accepted'].includes(s))
            );
        case 'interview':
            return (
                ['interview', 'hired', 'accepted'].includes(norm) ||
                Boolean(app.interview && ['Scheduled', 'Rescheduled'].includes(app.interview.status)) ||
                historyStatuses.some(s => ['interview', 'hired', 'accepted'].includes(s))
            );
        case 'offered':
            return (
                ['hired', 'accepted'].includes(norm) ||
                (app.placement && app.placement.outcome === 'accepted') ||
                historyStatuses.some(s => ['hired', 'accepted'].includes(s))
            );
        default:
            return false;
    }
}

function detectWorkMode(internship) {
    if (!internship) return 'On-site';
    const loc = internship.location;
    let locStr = '';
    if (typeof loc === 'string') {
        locStr = loc.toLowerCase();
    } else if (loc && typeof loc === 'object') {
        locStr = `${loc.district || ''} ${loc.state || ''}`.toLowerCase();
    }
    const text = `${internship.title || ''} ${internship.description || ''} ${locStr}`.toLowerCase();

    if (text.includes('remote') || text.includes('work from home') || text.includes('wfh')) {
        return 'Remote';
    }
    if (text.includes('hybrid')) {
        return 'Hybrid';
    }
    return 'On-site';
}

function safeJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/**
 * Computes deep candidate analytics
 */
function computeCandidateAnalytics(candidate = {}, allApplications = [], options = {}) {
    const range = parseRange(options.range);
    const { currentStart, prevStart, now, days } = getTimeWindows(range);

    const safeApps = Array.isArray(allApplications) ? allApplications : [];

    // Filter applications for current time range
    const appsInRange = safeApps.filter(app => {
        const date = new Date(app.appliedAt || app.createdAt || Date.now());
        return range === 'all' || date >= currentStart;
    });

    // Previous window applications for trend deltas
    const appsInPrevRange = range === 'all' ? [] : safeApps.filter(app => {
        const date = new Date(app.appliedAt || app.createdAt || Date.now());
        return date >= prevStart && date < currentStart;
    });

    const totalSubmitted = appsInRange.length;
    const prevSubmitted = appsInPrevRange.length;

    // Active applications (in progress, not terminal)
    const activeApps = appsInRange.filter(app => {
        const norm = normalizeStatus(app.status);
        return ['submitted', 'pending', 'under review', 'shortlisted', 'interview'].includes(norm);
    });

    // Shortlisted / Interview / Hired count
    const shortlistInterviewApps = appsInRange.filter(app => hasReachedStage(app, 'shortlisted'));
    const shortlistInterviewRate = totalSubmitted > 0
        ? Math.round((shortlistInterviewApps.length / totalSubmitted) * 100)
        : 0;

    const prevShortlistInterviewApps = appsInPrevRange.filter(app => hasReachedStage(app, 'shortlisted'));
    const prevShortlistInterviewRate = prevSubmitted > 0
        ? Math.round((prevShortlistInterviewApps.length / prevSubmitted) * 100)
        : 0;

    // Offers received
    const offersReceived = appsInRange.filter(app => hasReachedStage(app, 'offered')).length;
    const prevOffers = appsInPrevRange.filter(app => hasReachedStage(app, 'offered')).length;

    // Scheduled interviews
    const interviewsScheduled = appsInRange.filter(app => hasReachedStage(app, 'interview')).length;

    // Terminated outcomes
    const rejectedCount = appsInRange.filter(app => normalizeStatus(app.status) === 'rejected').length;
    const withdrawnCount = appsInRange.filter(app => normalizeStatus(app.status) === 'withdrawn').length;

    // Average recruiter response time in days
    const responseTimes = [];
    appsInRange.forEach(app => {
        const norm = normalizeStatus(app.status);
        if (norm !== 'submitted' && norm !== 'pending') {
            const appliedDate = new Date(app.appliedAt || app.createdAt || Date.now());
            const updatedDate = new Date(app.statusUpdatedAt || app.updatedAt || Date.now());
            const diffDays = (updatedDate - appliedDate) / (1000 * 60 * 60 * 24);
            if (diffDays >= 0 && diffDays <= 180) {
                responseTimes.push(diffDays);
            }
        }
    });

    const avgResponseDays = responseTimes.length > 0
        ? (responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length).toFixed(1)
        : null;

    // Funnel construction
    const funnelCounts = {
        applied: totalSubmitted,
        under_review: appsInRange.filter(a => hasReachedStage(a, 'under_review')).length,
        shortlisted: appsInRange.filter(a => hasReachedStage(a, 'shortlisted')).length,
        interview: appsInRange.filter(a => hasReachedStage(a, 'interview')).length,
        offered: offersReceived
    };

    let previousStageCount = totalSubmitted;
    const funnel = FUNNEL_STAGES.map(stage => {
        const count = funnelCounts[stage.key] || 0;
        const percentageOfTotal = totalSubmitted > 0 ? Math.round((count / totalSubmitted) * 100) : 0;
        const conversionFromPrev = previousStageCount > 0 ? Math.round((count / previousStageCount) * 100) : 0;
        previousStageCount = count > 0 ? count : previousStageCount;

        return {
            key: stage.key,
            label: stage.label,
            color: stage.color,
            icon: stage.icon,
            count,
            percentage: percentageOfTotal,
            conversion: conversionFromPrev
        };
    });

    // Activity & Trend Timeline Data
    const timeline = generateActivityTimeline(appsInRange, range, days);

    // Sector & Domain Distribution
    const sectorMap = {};
    appsInRange.forEach(app => {
        const sector = (app.internship && app.internship.sector) ? app.internship.sector.trim() : 'General';
        sectorMap[sector] = (sectorMap[sector] || 0) + 1;
    });

    const sectorColors = ['#4f46e5', '#0284c7', '#8b5cf6', '#d97706', '#059669', '#e11d48', '#0d9488'];
    const sectors = Object.entries(sectorMap)
        .map(([sector, count], idx) => ({
            sector,
            count,
            percentage: totalSubmitted > 0 ? Math.round((count / totalSubmitted) * 100) : 0,
            color: sectorColors[idx % sectorColors.length]
        }))
        .sort((a, b) => b.count - a.count);

    // Work Mode Distribution
    const workModeCounts = { Remote: 0, Hybrid: 0, 'On-site': 0 };
    appsInRange.forEach(app => {
        const mode = detectWorkMode(app.internship);
        workModeCounts[mode] = (workModeCounts[mode] || 0) + 1;
    });

    const workModes = Object.entries(workModeCounts).map(([mode, count]) => ({
        mode,
        count,
        percentage: totalSubmitted > 0 ? Math.round((count / totalSubmitted) * 100) : 0
    }));

    // Top Companies
    const companyMap = {};
    appsInRange.forEach(app => {
        const comp = (app.internship && (app.internship.companyName || app.internship.company)) || 'Partner Employer';
        companyMap[comp] = (companyMap[comp] || 0) + 1;
    });
    const topCompanies = Object.entries(companyMap)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

    // Profile Health
    let profileCompletion = { percentage: 0, missingItems: [], completedItems: [] };
    if (typeof calculateProfileCompletion === 'function') {
        profileCompletion = calculateProfileCompletion(candidate);
    }

    // Actionable Insights
    const insights = generateActionableInsights({
        candidate,
        totalSubmitted,
        activeCount: activeApps.length,
        shortlistRate: shortlistInterviewRate,
        interviewsScheduled,
        offersReceived,
        avgResponseDays,
        profileCompletion,
        sectors
    });

    // Recent Status Updates Stream
    const recentActivity = appsInRange
        .slice()
        .sort((a, b) => new Date(b.statusUpdatedAt || b.updatedAt || 0) - new Date(a.statusUpdatedAt || a.updatedAt || 0))
        .slice(0, 6)
        .map(app => ({
            id: app._id,
            title: app.internship?.title || 'Internship Opportunity',
            company: app.internship?.companyName || app.internship?.company || 'Organization',
            status: app.status || 'Submitted',
            date: app.statusUpdatedAt || app.appliedAt || app.createdAt,
            matchScore: app.matchScore || 0
        }));

    return {
        range: String(range),
        days: days || 30,
        totals: {
            submitted: {
                current: totalSubmitted,
                previous: prevSubmitted,
                change: percentageChange(totalSubmitted, prevSubmitted)
            },
            active: {
                current: activeApps.length,
                percentage: totalSubmitted > 0 ? Math.round((activeApps.length / totalSubmitted) * 100) : 0
            },
            shortlistRate: {
                current: shortlistInterviewRate,
                previous: prevShortlistInterviewRate,
                change: shortlistInterviewRate - prevShortlistInterviewRate
            },
            offers: {
                current: offersReceived,
                previous: prevOffers,
                change: percentageChange(offersReceived, prevOffers)
            },
            interviews: interviewsScheduled,
            rejected: rejectedCount,
            withdrawn: withdrawnCount,
            avgResponseDays
        },
        funnel,
        timeline,
        sectors,
        workModes,
        topCompanies,
        profileHealth: profileCompletion,
        insights,
        recentActivity
    };
}

function generateActivityTimeline(apps, range, days = 30) {
    const buckets = [];
    const submissions = [];
    const responses = [];

    if (range === 7) {
        // Daily for 7 days
        for (let i = 6; i >= 0; i--) {
            const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
            const label = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
            buckets.push(label);
            const startOfDay = new Date(d.setHours(0, 0, 0, 0));
            const endOfDay = new Date(d.setHours(23, 59, 59, 999));

            const subs = apps.filter(a => {
                const date = new Date(a.appliedAt || a.createdAt);
                return date >= startOfDay && date <= endOfDay;
            }).length;

            const resps = apps.filter(a => {
                const norm = normalizeStatus(a.status);
                if (norm === 'submitted' || norm === 'pending') return false;
                const date = new Date(a.statusUpdatedAt || a.updatedAt);
                return date >= startOfDay && date <= endOfDay;
            }).length;

            submissions.push(subs);
            responses.push(resps);
        }
    } else if (range === 90) {
        // 12 weeks
        for (let i = 11; i >= 0; i--) {
            const start = new Date(Date.now() - (i + 1) * 7 * 24 * 60 * 60 * 1000);
            const end = new Date(Date.now() - i * 7 * 24 * 60 * 60 * 1000);
            const label = `W-${i === 0 ? 'Now' : i + 1}`;
            buckets.push(label);

            const subs = apps.filter(a => {
                const date = new Date(a.appliedAt || a.createdAt);
                return date >= start && date < end;
            }).length;

            const resps = apps.filter(a => {
                const norm = normalizeStatus(a.status);
                if (norm === 'submitted' || norm === 'pending') return false;
                const date = new Date(a.statusUpdatedAt || a.updatedAt);
                return date >= start && date < end;
            }).length;

            submissions.push(subs);
            responses.push(resps);
        }
    } else {
        // Default 30 days: 6 intervals of 5 days
        for (let i = 5; i >= 0; i--) {
            const start = new Date(Date.now() - (i + 1) * 5 * 24 * 60 * 60 * 1000);
            const end = new Date(Date.now() - i * 5 * 24 * 60 * 60 * 1000);
            const label = end.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
            buckets.push(label);

            const subs = apps.filter(a => {
                const date = new Date(a.appliedAt || a.createdAt);
                return date >= start && date < end;
            }).length;

            const resps = apps.filter(a => {
                const norm = normalizeStatus(a.status);
                if (norm === 'submitted' || norm === 'pending') return false;
                const date = new Date(a.statusUpdatedAt || a.updatedAt);
                return date >= start && date < end;
            }).length;

            submissions.push(subs);
            responses.push(resps);
        }
    }

    return {
        labels: buckets,
        submissions,
        responses
    };
}

function generateActionableInsights({
    totalSubmitted,
    activeCount,
    shortlistRate,
    interviewsScheduled,
    offersReceived,
    avgResponseDays,
    profileCompletion,
    sectors
}) {
    const list = [];

    // 1. Profile Completion Insight
    if (profileCompletion && profileCompletion.percentage < 85) {
        list.push({
            type: 'warning',
            icon: 'ph-identification-badge',
            title: `Profile is ${profileCompletion.percentage}% complete`,
            message: 'Complete your missing profile details to help recruiter matching algorithms prioritize your applications.',
            actionText: 'Complete Profile',
            actionHref: '/candidate/profile'
        });
    } else {
        list.push({
            type: 'success',
            icon: 'ph-check-circle',
            title: 'Profile strength is optimal',
            message: 'Your candidate profile has all key PMIS criteria filled, ensuring maximum visibility with verified employers.',
            actionText: 'View Profile',
            actionHref: '/candidate/profile'
        });
    }

    // 2. Application volume & momentum
    if (totalSubmitted === 0) {
        list.push({
            type: 'info',
            icon: 'ph-compass',
            title: 'Start your internship journey',
            message: 'Discover tailored opportunities posted by top partner organizations under PMIS.',
            actionText: 'Explore Internships',
            actionHref: '/internships'
        });
    } else if (totalSubmitted < 5) {
        list.push({
            type: 'info',
            icon: 'ph-chart-line-up',
            title: 'Expand your application reach',
            message: 'Candidates who apply to at least 5-10 matched openings receive interview invitations 3x faster.',
            actionText: 'Browse Openings',
            actionHref: '/internships'
        });
    }

    // 3. Shortlist rate / Conversion insight
    if (totalSubmitted >= 3) {
        if (shortlistRate >= 25) {
            list.push({
                type: 'success',
                icon: 'ph-star',
                title: 'High shortlisting rate',
                message: `Your shortlisting conversion is ${shortlistRate}%, which is well above the platform benchmark! Your skills are closely aligned with employer demands.`,
                actionText: 'Track Statuses',
                actionHref: '/candidate/applications'
            });
        } else if (shortlistRate < 10) {
            list.push({
                type: 'tip',
                icon: 'ph-lightbulb',
                title: 'Tailor your application kit',
                message: 'Customizing your projects and skills for each job description significantly boosts recruiter review scores.',
                actionText: 'Skill Assessments',
                actionHref: '/problems'
            });
        }
    }

    // 4. Interview preparation insight
    if (interviewsScheduled > 0) {
        list.push({
            type: 'warning',
            icon: 'ph-video-camera',
            title: `${interviewsScheduled} interview(s) scheduled`,
            message: 'Prepare for technical and behavioral rounds in our mock interview room before your session.',
            actionText: 'Practice Mock Interview',
            actionHref: '/interview'
        });
    }

    // 5. Response time expectation
    if (activeCount > 0) {
        list.push({
            type: 'info',
            icon: 'ph-clock',
            title: `${activeCount} active application(s) pending review`,
            message: avgResponseDays
                ? `Employers historically take ~${avgResponseDays} days to review applications. We'll alert you the moment your status changes.`
                : 'Recruiters typically review applications within 7 to 10 days of submission. Keep an eye on your notification bell!',
            actionText: 'View Applications',
            actionHref: '/candidate/applications'
        });
    }

    return list;
}

module.exports = {
    FUNNEL_STAGES,
    normalizeStatus,
    parseRange,
    getTimeWindows,
    percentageChange,
    hasReachedStage,
    detectWorkMode,
    safeJson,
    computeCandidateAnalytics
};
