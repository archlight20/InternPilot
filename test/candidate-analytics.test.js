const test = require('node:test');
const assert = require('node:assert/strict');
const {
    computeCandidateAnalytics,
    hasReachedStage,
    detectWorkMode,
    parseRange,
    safeJson
} = require('../utils/candidateAnalytics');

test('parseRange defaults to 30 and permits 7, 30, 90, and all', () => {
    assert.equal(parseRange(), 30);
    assert.equal(parseRange('invalid'), 30);
    assert.equal(parseRange('7'), 7);
    assert.equal(parseRange('30'), 30);
    assert.equal(parseRange('90'), 90);
    assert.equal(parseRange('all'), 'all');
});

test('detectWorkMode classifies remote, hybrid, and on-site', () => {
    assert.equal(detectWorkMode(null), 'On-site');
    assert.equal(detectWorkMode({ location: 'Remote' }), 'Remote');
    assert.equal(detectWorkMode({ location: { district: 'Remote' } }), 'Remote');
    assert.equal(detectWorkMode({ title: 'Full Stack Engineer (Work from home)' }), 'Remote');
    assert.equal(detectWorkMode({ description: 'This is a Hybrid role located in Pune' }), 'Hybrid');
    assert.equal(detectWorkMode({ location: { district: 'Pune', state: 'Maharashtra' } }), 'On-site');
});

test('hasReachedStage accurately identifies pipeline milestones', () => {
    const appSubmitted = { status: 'Submitted', statusHistory: [] };
    const appUnderReview = { status: 'Under Review', statusHistory: [{ status: 'Submitted' }, { status: 'Under Review' }] };
    const appShortlisted = { status: 'Shortlisted', statusHistory: [{ status: 'Submitted' }, { status: 'Shortlisted' }] };
    const appInterview = { status: 'Interview', interview: { status: 'Scheduled' }, statusHistory: [] };
    const appHired = { status: 'Hired', statusHistory: [] };

    assert.equal(hasReachedStage(appSubmitted, 'applied'), true);
    assert.equal(hasReachedStage(appSubmitted, 'under_review'), false);

    assert.equal(hasReachedStage(appUnderReview, 'under_review'), true);
    assert.equal(hasReachedStage(appUnderReview, 'shortlisted'), false);

    assert.equal(hasReachedStage(appShortlisted, 'shortlisted'), true);
    assert.equal(hasReachedStage(appShortlisted, 'interview'), false);

    assert.equal(hasReachedStage(appInterview, 'interview'), true);
    assert.equal(hasReachedStage(appHired, 'offered'), true);
    assert.equal(hasReachedStage(appHired, 'applied'), true);
    assert.equal(hasReachedStage(appHired, 'under_review'), true);
    assert.equal(hasReachedStage(appHired, 'shortlisted'), true);
});

test('computeCandidateAnalytics handles empty applications gracefully', () => {
    const candidate = { _id: 'c1', name: 'Student One', role: 'candidate' };
    const analytics = computeCandidateAnalytics(candidate, [], { range: '30' });

    assert.equal(analytics.totals.submitted.current, 0);
    assert.equal(analytics.totals.active.current, 0);
    assert.equal(analytics.totals.shortlistRate.current, 0);
    assert.equal(analytics.totals.offers.current, 0);
    assert.equal(analytics.funnel.length, 5);
    assert.equal(analytics.funnel[0].count, 0);
    assert.equal(analytics.funnel[0].percentage, 0);
    assert.equal(analytics.sectors.length, 0);
    assert.ok(Array.isArray(analytics.insights));
    assert.ok(analytics.insights.some(i => i.title.includes('Start your internship journey')));
});

test('computeCandidateAnalytics calculates accurate KPIs, funnel conversion, and distributions', () => {
    const candidate = {
        _id: 'c1',
        name: 'Student Two',
        role: 'candidate',
        skills: [{ name: 'JavaScript', proficiency: 'Intermediate' }],
        education: { qualification: 'B.Tech', institutionName: 'University' }
    };

    const now = new Date();
    const mockApplications = [
        {
            _id: 'a1',
            status: 'Submitted',
            appliedAt: new Date(now.getTime() - 2 * 86400000),
            internship: { title: 'Frontend Intern', companyName: 'Acme Corp', sector: 'Information Technology', location: 'Remote' }
        },
        {
            _id: 'a2',
            status: 'Under Review',
            appliedAt: new Date(now.getTime() - 5 * 86400000),
            statusUpdatedAt: new Date(now.getTime() - 3 * 86400000),
            internship: { title: 'Backend Intern', companyName: 'Acme Corp', sector: 'Information Technology', location: { district: 'Bengaluru', state: 'Karnataka' } }
        },
        {
            _id: 'a3',
            status: 'Shortlisted',
            appliedAt: new Date(now.getTime() - 10 * 86400000),
            statusUpdatedAt: new Date(now.getTime() - 6 * 86400000),
            internship: { title: 'Data Analyst', companyName: 'FinTech Ltd', sector: 'Finance', location: 'Hybrid' }
        },
        {
            _id: 'a4',
            status: 'Interview',
            interview: { status: 'Scheduled', scheduledAt: new Date(now.getTime() + 86400000) },
            appliedAt: new Date(now.getTime() - 15 * 86400000),
            statusUpdatedAt: new Date(now.getTime() - 12 * 86400000),
            internship: { title: 'ML Intern', companyName: 'AI Labs', sector: 'Information Technology', location: 'Remote' }
        },
        {
            _id: 'a5',
            status: 'Hired',
            appliedAt: new Date(now.getTime() - 20 * 86400000),
            statusUpdatedAt: new Date(now.getTime() - 10 * 86400000),
            internship: { title: 'Design Intern', companyName: 'Creative Studio', sector: 'Design', location: { district: 'Mumbai', state: 'Maharashtra' } }
        }
    ];

    const analytics = computeCandidateAnalytics(candidate, mockApplications, { range: '30' });

    assert.equal(analytics.totals.submitted.current, 5);
    // Active are: Submitted, Under Review, Shortlisted, Interview = 4
    assert.equal(analytics.totals.active.current, 4);
    // Shortlisted or beyond: a3, a4, a5 = 3 out of 5 => 60%
    assert.equal(analytics.totals.shortlistRate.current, 60);
    // Offers: a5 = 1
    assert.equal(analytics.totals.offers.current, 1);
    assert.equal(analytics.totals.interviews, 2); // a4 and a5

    // Funnel checks
    assert.equal(analytics.funnel[0].count, 5); // Applied
    assert.equal(analytics.funnel[1].count, 4); // Under Review (a2, a3, a4, a5)
    assert.equal(analytics.funnel[2].count, 3); // Shortlisted (a3, a4, a5)
    assert.equal(analytics.funnel[3].count, 2); // Interview (a4, a5)
    assert.equal(analytics.funnel[4].count, 1); // Offered (a5)

    // Sector breakdown
    assert.ok(analytics.sectors.some(s => s.sector === 'Information Technology' && s.count === 3));
    assert.ok(analytics.sectors.some(s => s.sector === 'Finance' && s.count === 1));

    // Work modes: Remote (2), Hybrid (1), On-site (2)
    const remote = analytics.workModes.find(w => w.mode === 'Remote');
    const hybrid = analytics.workModes.find(w => w.mode === 'Hybrid');
    const onsite = analytics.workModes.find(w => w.mode === 'On-site');
    assert.equal(remote.count, 2);
    assert.equal(hybrid.count, 1);
    assert.equal(onsite.count, 2);

    // Insights check
    assert.ok(analytics.insights.length >= 3);
});

test('safeJson escapes unsafe HTML characters in JSON stringification', () => {
    const raw = { script: '</script><script>alert(1)</script>', amp: 'A & B', tag: '<bold>' };
    const sanitized = safeJson(raw);
    assert.doesNotMatch(sanitized, /<\/script>/);
    assert.match(sanitized, /\\u003c\/script\\u003e/);
    assert.match(sanitized, /\\u0026/);
});

test('candidate routes expose GET /candidate/analytics and /candidate/insights', () => {
    const candidateRouter = require('../routes/candidate');
    const routes = candidateRouter.stack
        .filter(entry => entry.route)
        .map(entry => ({ path: entry.route.path, methods: Object.keys(entry.route.methods) }));

    const analyticsRoute = routes.find(r => r.path === '/candidate/analytics');
    const insightsRoute = routes.find(r => r.path === '/candidate/insights');

    assert.ok(analyticsRoute, 'GET /candidate/analytics must be registered');
    assert.ok(analyticsRoute.methods.includes('get'));

    assert.ok(insightsRoute, 'GET /candidate/insights must be registered');
    assert.ok(insightsRoute.methods.includes('get'));
});

test('views/candidate/analytics.ejs compiles with both empty state and populated state', () => {
    const fs = require('fs');
    const path = require('path');
    const ejs = require('ejs');

    const templatePath = path.join(__dirname, '..', 'views', 'candidate', 'analytics.ejs');
    const templateContent = fs.readFileSync(templatePath, 'utf8').replace("<% layout('layouts/boilerplate') %>", '');

    const candidate = { _id: 'c1', name: 'Student Test', role: 'candidate' };

    // 1. Populated analytics state
    const populatedAnalytics = computeCandidateAnalytics(candidate, [
        {
            _id: 'a1',
            status: 'Shortlisted',
            appliedAt: new Date(),
            internship: { title: 'Software Intern', companyName: 'Google', sector: 'Information Technology' }
        }
    ], { range: '30' });

    const htmlPopulated = ejs.render(templateContent, {
        candidate,
        currentUser: candidate,
        analytics: populatedAnalytics,
        safeJson,
        pageTitle: 'Application Analytics'
    }, { filename: templatePath });

    assert.match(htmlPopulated, /Application Analytics & Insights/);
    assert.match(htmlPopulated, /Total Submitted/);
    assert.match(htmlPopulated, /Application Funnel & Progression/);
    assert.match(htmlPopulated, /Submission & Response Timeline/);
    assert.match(htmlPopulated, /Target Industry Sectors/);
    assert.match(htmlPopulated, /Actionable Recommendations/);
    assert.match(htmlPopulated, /id="candidateActivityChart"/);

    // 2. Empty state
    const emptyAnalytics = computeCandidateAnalytics(candidate, [], { range: '30' });
    const htmlEmpty = ejs.render(templateContent, {
        candidate,
        currentUser: candidate,
        analytics: emptyAnalytics,
        safeJson,
        pageTitle: 'Application Analytics'
    }, { filename: templatePath });

    assert.match(htmlEmpty, /Your Search Journey Starts Here/);
    assert.match(htmlEmpty, /Explore Internships/);
});

