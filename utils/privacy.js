const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');

const User = require('../models/User');
const Application = require('../models/Application');
const Internship = require('../models/Internship');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const Grievance = require('../models/Grievance');
const ResumeParse = require('../models/ResumeParse');
const Recommendation = require('../models/Recommendation');
const SavedSearch = require('../models/SavedSearch');
const SavedSearchAlertDelivery = require('../models/SavedSearchAlertDelivery');
const MockInterviewSession = require('../models/MockInterviewSession');
const ResumeProblemSet = require('../models/ResumeProblemSet');
const AccountSuspension = require('../models/AccountSuspension');
const Certificate = require('../models/Certificate');
const Review = require('../models/Review');
const ActivityLog = require('../models/ActivityLog');
const AdminAuditLog = require('../models/AdminAuditLog');
const AdminAction = require('../models/AdminAction');
const { logAdminAction } = require('./adminAudit');

// ── In-Memory Rate Limiter ──────────────────────────────────────────
const rateLimitStore = new Map();

function cleanExpiredRateLimits() {
    const now = Date.now();
    for (const [key, record] of rateLimitStore.entries()) {
        if (now > record.resetTime) {
            rateLimitStore.delete(key);
        }
    }
}

/**
 * Checks and increments rate limit counter for a given key.
 * @param {string} key e.g. "download:userId" or "delete:userId"
 * @param {object} options { max: number, windowMs: number }
 * @returns {{ allowed: boolean, remaining: number, retryAfterSeconds: number }}
 */
function checkRateLimit(key, { max = 5, windowMs = 15 * 60 * 1000 } = {}) {
    cleanExpiredRateLimits();
    const now = Date.now();
    let record = rateLimitStore.get(key);

    if (!record || now > record.resetTime) {
        record = { count: 1, resetTime: now + windowMs };
        rateLimitStore.set(key, record);
        return { allowed: true, remaining: max - 1, retryAfterSeconds: 0 };
    }

    if (record.count >= max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((record.resetTime - now) / 1000));
        return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    record.count += 1;
    return { allowed: true, remaining: max - record.count, retryAfterSeconds: 0 };
}

function resetRateLimit(key) {
    rateLimitStore.delete(key);
}

// ── Deletion Blocker Checks ─────────────────────────────────────────
/**
 * Evaluates whether an account can be deleted or is blocked.
 * Company owners are blocked if they still have published listings or active team members.
 */
async function getDeletionBlocker(user) {
    if (!user) {
        return { blocked: true, message: 'User not found.' };
    }

    if (user.role === 'admin') {
        return { blocked: true, message: "Admin accounts cannot be deleted through self-service." };
    }

    if (user.role === 'company') {
        const companyId = user._id;

        const [liveListings, teamMembers] = await Promise.all([
            Internship.find({
                $or: [{ companyId }, { postedBy: companyId }],
                status: 'published'
            }).select('title').lean(),
            User.find({
                companyId,
                _id: { $ne: companyId }
            }).select('name email role').lean()
        ]);

        if (liveListings.length > 0) {
            return {
                blocked: true,
                reason: 'active_listings',
                count: liveListings.length,
                items: liveListings.map(l => l.title),
                message: `You cannot delete your company account while you have ${liveListings.length} live internship listing(s) (${liveListings.slice(0, 3).map(l => `"${l.title}"`).join(', ')}${liveListings.length > 3 ? '...' : ''}). Please close or unpublish them before deleting your account.`
            };
        }

        if (teamMembers.length > 0) {
            return {
                blocked: true,
                reason: 'team_members',
                count: teamMembers.length,
                items: teamMembers.map(m => m.name || m.email),
                message: `You cannot delete your company account while you have ${teamMembers.length} active team member(s) (${teamMembers.slice(0, 3).map(m => m.name || m.email).join(', ')}${teamMembers.length > 3 ? '...' : ''}). Please remove all team members from Manage Team before closing the account.`
            };
        }
    }

    return null;
}

// ── Data Preview ────────────────────────────────────────────────────
/**
 * Assembles an exact count preview of what records will be erased.
 */
async function getPersonalDataPreview(user) {
    const userId = user._id;
    const isCandidate = user.role === 'candidate';
    const isCompany = user.role === 'company';

    const preview = {
        role: user.role,
        profileFields: [
            user.name ? 'Full Name' : null,
            user.email ? 'Email Address' : null,
            user.qualification ? 'Educational Qualifications' : null,
            user.location?.district || user.location?.state ? 'Location' : null,
            (user.skills && user.skills.length) ? 'Skills & Competencies' : null
        ].filter(Boolean).length,
        items: []
    };

    if (isCandidate) {
        const [
            appsCount,
            savedSearchesCount,
            convs,
            notifsCount,
            grievancesCount,
            mockCount,
            problemCount,
            certsCount,
            reviewsCount
        ] = await Promise.all([
            Application.countDocuments({ candidate: userId }),
            SavedSearch.countDocuments({ candidate: userId }),
            Conversation.find({ candidate: userId }).select('_id').lean(),
            Notification.countDocuments({ recipient: userId }),
            Grievance.countDocuments({ raisedBy: userId }),
            MockInterviewSession.countDocuments({ candidate: userId }),
            ResumeProblemSet.countDocuments({ candidate: userId }),
            Certificate.countDocuments({ candidate: userId }),
            Review.countDocuments({ candidate: userId })
        ]);

        const convIds = convs.map(c => c._id);
        const msgCount = convIds.length ? await Message.countDocuments({ conversation: { $in: convIds } }) : 0;
        const savedInternshipsCount = (Array.isArray(user.savedInternships)) ? user.savedInternships.length : 0;
        const resumesCount = (user.resume ? 1 : 0) + (Array.isArray(user.resumeVersions) ? user.resumeVersions.length : 0);

        preview.items = [
            { key: 'profile', label: 'Candidate Profile & Experience Records', count: 1, icon: 'ph-user' },
            { key: 'resumes', label: 'Uploaded Resumes & AI Version Artifacts', count: resumesCount, icon: 'ph-file-text' },
            { key: 'applications', label: 'Internship Applications & Status History', count: appsCount, icon: 'ph-paper-plane-tilt' },
            { key: 'savedInternships', label: 'Bookmarked Opportunities', count: savedInternshipsCount, icon: 'ph-bookmark-simple' },
            { key: 'savedSearches', label: 'Saved Searches & Email Alert Criteria', count: savedSearchesCount, icon: 'ph-magnifying-glass' },
            { key: 'conversations', label: 'Direct Messages & Recruiter Chat History', count: msgCount, icon: 'ph-chat-circle-dots' },
            { key: 'notifications', label: 'Account Notifications & Alerts', count: notifsCount, icon: 'ph-bell' },
            { key: 'grievances', label: 'Grievance Redressal Tickets', count: grievancesCount, icon: 'ph-warning-octagon' },
            { key: 'mockInterviews', label: 'AI Mock Interview Transcripts & Scores', count: mockCount, icon: 'ph-microphone' },
            { key: 'problemSets', label: 'Technical Practice Sets & Submissions', count: problemCount, icon: 'ph-code' },
            { key: 'certificates', label: 'Issued Scheme Certificates', count: certsCount, icon: 'ph-certificate' },
            { key: 'reviews', label: 'Company Reviews & Ratings', count: reviewsCount, icon: 'ph-star' }
        ];
    } else if (isCompany) {
        const [listingsCount, appsCount, notifsCount, activityCount] = await Promise.all([
            Internship.countDocuments({ $or: [{ companyId: userId }, { postedBy: userId }] }),
            Application.countDocuments({ companyId: userId }),
            Notification.countDocuments({ companyId: userId }),
            ActivityLog.countDocuments({ companyId: userId })
        ]);

        preview.items = [
            { key: 'profile', label: 'Company Entity Account & Details', count: 1, icon: 'ph-buildings' },
            { key: 'listings', label: 'Draft & Closed Internship Listings', count: listingsCount, icon: 'ph-briefcase' },
            { key: 'applications', label: 'Received Candidate Application Records', count: appsCount, icon: 'ph-paper-plane-tilt' },
            { key: 'notifications', label: 'Company Notifications & Activity Logs', count: notifsCount + activityCount, icon: 'ph-bell' }
        ];
    } else {
        const notifsCount = await Notification.countDocuments({ recipient: userId });
        preview.items = [
            { key: 'profile', label: 'Team Member Account Credentials', count: 1, icon: 'ph-user' },
            { key: 'notifications', label: 'User Notifications & Alerts', count: notifsCount, icon: 'ph-bell' }
        ];
    }

    return preview;
}

// ── Data Export Builder ─────────────────────────────────────────────
/**
 * Queries and constructs a complete, isolated JSON payload containing
 * all data belonging strictly to the specified user.
 */
async function buildUserDataExport(user) {
    const userId = user._id;
    const isCandidate = user.role === 'candidate';
    const isCompany = user.role === 'company';

    // 1. Base User Profile (Sanitized, password strictly omitted)
    const profile = {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        avatar: user.avatar || null
    };

    if (isCandidate) {
        Object.assign(profile, {
            age: user.age || null,
            familyIncome: user.familyIncome || null,
            institution: user.institution || null,
            qualification: user.qualification || (user.education?.qualification) || null,
            enrollmentStatus: user.enrollmentStatus || null,
            employmentStatus: user.employmentStatus || null,
            location: user.location || {},
            education: user.education || {},
            skills: user.skills || [],
            skillProfiles: user.skillProfiles || [],
            projects: user.projects || [],
            certifications: user.certifications || [],
            resume: {
                currentResumeUrl: user.resume || null,
                originalFileName: user.resumeOriginalName || null,
                uploadedAt: user.resumeUploadedAt || null,
                versions: user.resumeVersions || [],
                qualityFeedback: user.resumeQuality || null
            }
        });
    } else if (isCompany) {
        Object.assign(profile, {
            companyDetails: user.companyDetails || {}
        });
    }

    // 2. Applications (with populated internship summary)
    let applications = [];
    if (isCandidate) {
        const rawApps = await Application.find({ candidate: userId })
            .populate('internship', 'title companyName sector duration monthlyStipend location status')
            .lean();

        applications = rawApps.map(app => ({
            id: app._id,
            internshipTitle: app.internship?.title || 'Internship Listing',
            companyName: app.internship?.companyName || 'Host Organization',
            sector: app.internship?.sector || null,
            status: app.status,
            appliedAt: app.createdAt || app.appliedAt,
            timeline: app.timeline || [],
            statusHistory: app.statusHistory || [],
            coverLetter: app.coverLetter || null,
            customAnswers: app.customAnswers || [],
            withdrawnAt: app.withdrawnAt || null,
            withdrawnReason: app.withdrawnReason || null
        }));
    }

    // 3. Saved Searches
    let savedSearches = [];
    if (isCandidate) {
        savedSearches = await SavedSearch.find({ candidate: userId })
            .select('title criteria alerts lastDeliveredAt createdAt updatedAt')
            .lean();
    }

    // 4. Saved Internships
    let savedInternships = [];
    if (isCandidate && Array.isArray(user.savedInternships) && user.savedInternships.length > 0) {
        savedInternships = await Internship.find({ _id: { $in: user.savedInternships } })
            .select('title companyName sector location duration monthlyStipend status')
            .lean();
    }

    // 5. Conversations & Messages
    let conversations = [];
    if (isCandidate) {
        const rawConvs = await Conversation.find({ candidate: userId })
            .populate('company', 'name companyDetails')
            .lean();

        const convIds = rawConvs.map(c => c._id);
        const messages = await Message.find({ conversation: { $in: convIds } })
            .sort({ createdAt: 1 })
            .lean();

        const messagesByConv = new Map();
        messages.forEach(m => {
            const cId = String(m.conversation);
            if (!messagesByConv.has(cId)) messagesByConv.set(cId, []);
            messagesByConv.get(cId).push({
                id: m._id,
                sender: String(m.sender) === String(userId) ? 'You' : 'Employer',
                body: m.body,
                createdAt: m.createdAt
            });
        });

        conversations = rawConvs.map(c => ({
            id: c._id,
            companyName: c.company?.companyDetails?.companyName || c.company?.name || 'Company',
            createdAt: c.createdAt,
            messages: messagesByConv.get(String(c._id)) || []
        }));
    }

    // 6. Notifications
    const notificationQuery = isCompany ? { companyId: userId } : { recipient: userId };
    const notifications = await Notification.find(notificationQuery)
        .select('type title message link createdAt isRead')
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();

    // 7. Grievances
    const grievances = await Grievance.find({ raisedBy: userId })
        .select('ticketId category subject description status createdAt resolution resolvedAt')
        .lean();

    // 8. Mock Interviews & Problem Sets
    let mockInterviews = [];
    let practiceProblems = [];
    let parsedResumeData = null;
    let certificates = [];
    let reviews = [];

    if (isCandidate) {
        const [mocks, problems, rParse, certs, revs] = await Promise.all([
            MockInterviewSession.find({ candidate: userId }).lean(),
            ResumeProblemSet.find({ candidate: userId }).lean(),
            ResumeParse.findOne({ user: userId }).lean(),
            Certificate.find({ candidate: userId }).lean(),
            Review.find({ candidate: userId }).lean()
        ]);
        mockInterviews = mocks;
        practiceProblems = problems;
        parsedResumeData = rParse ? { parsedData: rParse.parsedData, createdAt: rParse.createdAt } : null;
        certificates = certs;
        reviews = revs;
    }

    // Assemble export document
    const exportDocument = {
        exportMetadata: {
            platform: "InternPilot — Prime Minister's Internship Scheme Portal",
            legalFramework: "Digital Personal Data Protection Act, 2023 (DPDP Act, Section 11 & Section 12)",
            purpose: "Data Principal Right of Access & Data Portability",
            exportedAt: new Date().toISOString(),
            account: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role
            },
            summary: {
                applicationsCount: applications.length,
                savedInternshipsCount: savedInternships.length,
                savedSearchesCount: savedSearches.length,
                conversationsCount: conversations.length,
                notificationsCount: notifications.length,
                grievancesCount: grievances.length,
                mockInterviewsCount: mockInterviews.length,
                practiceProblemSetsCount: practiceProblems.length,
                certificatesCount: certificates.length,
                reviewsCount: reviews.length
            }
        },
        profile,
        applications,
        savedInternships,
        savedSearches,
        conversations,
        notifications,
        grievances,
        mockInterviews,
        practiceProblems,
        resumeParse: parsedResumeData,
        certificates,
        reviews
    };

    return exportDocument;
}

// ── Credential Verification ─────────────────────────────────────────
/**
 * Verifies deletion credentials: password for standard accounts,
 * email verification for OAuth/Google accounts, and explicit confirmation word "DELETE".
 */
async function verifyDeletionCredentials(user, { password, confirmEmail, confirmation } = {}) {
    const typedWord = String(confirmation || '').trim();
    if (typedWord !== 'DELETE') {
        return { ok: false, error: 'Please enter the word "DELETE" in capital letters to confirm account closure.' };
    }

    const isGoogleAccount = !user.password || Boolean(user.googleId);

    if (isGoogleAccount) {
        const typedEmail = String(confirmEmail || '').trim().toLowerCase();
        const userEmail = String(user.email || '').trim().toLowerCase();
        if (!typedEmail || typedEmail !== userEmail) {
            return { ok: false, error: `Please type your registered email address (${user.email}) exactly to confirm.` };
        }
    } else {
        const enteredPassword = String(password || '');
        if (!enteredPassword) {
            return { ok: false, error: 'Account password is required to confirm deletion.' };
        }
        const isMatch = await bcrypt.compare(enteredPassword, user.password);
        if (!isMatch) {
            return { ok: false, error: 'Incorrect password.' };
        }
    }

    return { ok: true };
}

// ── Account Deletion Execution ──────────────────────────────────────
/**
 * Permanently erases the user account and all personal data belonging to it.
 */
async function deleteUserAccount(user, { password, confirmEmail, confirmation } = {}) {
    // 1. Verify blockers
    const blocker = await getDeletionBlocker(user);
    if (blocker) {
        return { ok: false, error: blocker.message };
    }

    // 2. Verify credentials
    const cred = await verifyDeletionCredentials(user, { password, confirmEmail, confirmation });
    if (!cred.ok) {
        return { ok: false, error: cred.error };
    }

    const userId = user._id;
    const removed = {};

    // 3. Cascading Erase by Role
    if (user.role === 'candidate') {
        const convs = await Conversation.find({ candidate: userId }).select('_id').lean();
        const convIds = convs.map(c => c._id);
        removed.messages = (await Message.deleteMany({ conversation: { $in: convIds } })).deletedCount;
        removed.conversations = (await Conversation.deleteMany({ candidate: userId })).deletedCount;
        removed.applications = (await Application.deleteMany({ candidate: userId })).deletedCount;
        removed.savedSearches = (await SavedSearch.deleteMany({ candidate: userId })).deletedCount;
        removed.alertDeliveries = (await SavedSearchAlertDelivery.deleteMany({ candidate: userId })).deletedCount;
        removed.recommendations = (await Recommendation.deleteMany({ candidate: userId })).deletedCount;
        removed.resumeParses = (await ResumeParse.deleteMany({ user: userId })).deletedCount;
        removed.mockInterviews = (await MockInterviewSession.deleteMany({ candidate: userId })).deletedCount;
        removed.problemSets = (await ResumeProblemSet.deleteMany({ candidate: userId })).deletedCount;
        removed.certificates = (await Certificate.deleteMany({ candidate: userId })).deletedCount;
        removed.reviews = (await Review.deleteMany({ candidate: userId })).deletedCount;
        removed.notifications = (await Notification.deleteMany({ recipient: userId })).deletedCount;
        removed.grievances = (await Grievance.deleteMany({ raisedBy: userId })).deletedCount;
        removed.suspensions = (await AccountSuspension.deleteMany({ user: userId })).deletedCount;
    } else if (user.role === 'company') {
        removed.listings = (await Internship.deleteMany({ $or: [{ companyId: userId }, { postedBy: userId }] })).deletedCount;
        removed.applications = (await Application.deleteMany({ companyId: userId })).deletedCount;
        removed.notifications = (await Notification.deleteMany({ companyId: userId })).deletedCount;
        removed.activityLogs = (await ActivityLog.deleteMany({ companyId: userId })).deletedCount;
        removed.reviews = (await Review.deleteMany({ company: userId })).deletedCount;
        removed.grievances = (await Grievance.deleteMany({ raisedBy: userId })).deletedCount;
        removed.suspensions = (await AccountSuspension.deleteMany({ user: userId })).deletedCount;
    } else {
        removed.notifications = (await Notification.deleteMany({ recipient: userId })).deletedCount;
        removed.grievances = (await Grievance.deleteMany({ raisedBy: userId })).deletedCount;
        removed.suspensions = (await AccountSuspension.deleteMany({ user: userId })).deletedCount;
    }

    // 4. Delete User Account
    removed.user = (await User.deleteOne({ _id: userId })).deletedCount;

    // 5. Audit Logging
    try {
        await AdminAuditLog.create({
            actor: userId,
            action: 'ACCOUNT_DELETED',
            targetType: 'User',
            targetId: userId,
            reason: 'User self-requested account erasure under DPDP Act 2023',
            metadata: {
                role: user.role,
                email: user.email,
                removed
            }
        });
    } catch (auditErr) {
        console.error('Failed to log to AdminAuditLog on account deletion:', auditErr.message);
    }

    try {
        await logAdminAction(user, {
            action: 'user.delete',
            targetType: 'user',
            targetId: userId,
            targetLabel: `${user.name || 'User'} <${user.email || ''}>`,
            reason: 'User self-requested account erasure under DPDP Act 2023',
            details: removed
        });
    } catch (auditErr) {
        console.error('Failed to log to AdminAction on account deletion:', auditErr.message);
    }

    // 6. Confirmation Email
    try {
        await sendAccountDeletionConfirmationEmail({ email: user.email, name: user.name });
    } catch (mailErr) {
        console.warn('Could not dispatch account deletion email:', mailErr.message);
    }

    return { ok: true, removed };
}

// ── Email Confirmation ──────────────────────────────────────────────
async function sendAccountDeletionConfirmationEmail({ email, name }) {
    if (!email) return;

    const transporter = nodemailer.createTransport({
        service: process.env.EMAIL_SERVICE || 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    const safeName = String(name || 'User').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
    const safeEmail = String(email).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

    const mailOptions = {
        from: `"InternPilot Data Protection" <${process.env.EMAIL_USER || 'privacy@internpilot.gov.in'}>`,
        to: email,
        subject: 'Account Deletion Confirmation | InternPilot',
        html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; color: #1e293b; line-height: 1.6;">
                <div style="text-align: center; margin-bottom: 24px;">
                    <h2 style="color: #4338ca; margin: 0 0 6px 0;">InternPilot</h2>
                    <p style="margin: 0; font-size: 13px; color: #64748b;">Prime Minister's Internship Scheme Portal</p>
                </div>

                <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 18px; margin-bottom: 20px;">
                    <h3 style="margin-top: 0; color: #0f172a; font-size: 16px;">Account Deletion Confirmed</h3>
                    <p style="margin: 0 0 10px 0; font-size: 14px;">Hello <strong>${safeName}</strong>,</p>
                    <p style="margin: 0; font-size: 14px; color: #334155;">
                        As requested under India's <strong>Digital Personal Data Protection Act, 2023 (DPDP Act)</strong>, your InternPilot account linked to <strong>${safeEmail}</strong> has been permanently closed.
                    </p>
                </div>

                <p style="font-size: 14px; color: #475569;">
                    All personal data held on our active servers—including your candidate profile, uploaded resumes, submitted applications, interview transcripts, and chat conversations—has been permanently erased.
                </p>

                <div style="background: #eff6ff; border-left: 4px solid #3b82f6; padding: 12px 16px; margin: 20px 0; font-size: 13px; color: #1e40af;">
                    <strong>Date of Closure:</strong> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST<br/>
                    <strong>Reference:</strong> Statutory Erasure under DPDP Act 2023
                </div>

                <p style="font-size: 13px; color: #64748b; margin-top: 24px;">
                    Thank you for being part of InternPilot. Should you ever wish to apply for opportunities under the PM Internship Scheme in the future, you are always welcome to register afresh.
                </p>

                <div style="border-top: 1px solid #f1f5f9; padding-top: 16px; margin-top: 30px; font-size: 11px; color: #94a3b8; text-align: center;">
                    Ministry of Corporate Affairs &bull; Government of India
                </div>
            </div>
        `
    };

    return await transporter.sendMail(mailOptions);
}

// ── Exported API ────────────────────────────────────────────────────
module.exports = {
    checkRateLimit,
    resetRateLimit,
    getDeletionBlocker,
    getPersonalDataPreview,
    buildUserDataExport,
    verifyDeletionCredentials,
    deleteUserAccount,
    sendAccountDeletionConfirmationEmail
};
