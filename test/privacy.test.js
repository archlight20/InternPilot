const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const privacyRouter = require('../routes/privacy');
const {
    checkRateLimit,
    resetRateLimit,
    getDeletionBlocker,
    getPersonalDataPreview,
    buildUserDataExport,
    verifyDeletionCredentials,
    deleteUserAccount
} = require('../utils/privacy');

const User = require('../models/User');
const Application = require('../models/Application');
const Internship = require('../models/Internship');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const Grievance = require('../models/Grievance');
const SavedSearch = require('../models/SavedSearch');
const SavedSearchAlertDelivery = require('../models/SavedSearchAlertDelivery');
const Recommendation = require('../models/Recommendation');
const ResumeParse = require('../models/ResumeParse');
const MockInterviewSession = require('../models/MockInterviewSession');
const ResumeProblemSet = require('../models/ResumeProblemSet');
const Certificate = require('../models/Certificate');
const Review = require('../models/Review');
const AccountSuspension = require('../models/AccountSuspension');
const AdminAuditLog = require('../models/AdminAuditLog');
const AdminAction = require('../models/AdminAction');

function routeLayer(router, routePath, method) {
    return router.stack.find(layer =>
        layer.route && layer.route.path === routePath && layer.route.methods[method]
    );
}

// ── 1. Route Registration & Middleware ──────────────────────────────
test('privacy routes are registered with isAuthenticated middleware', () => {
    const expected = [
        ['get', '/account/privacy'],
        ['get', '/account/privacy/download'],
        ['post', '/account/privacy/delete']
    ];

    expected.forEach(([method, routePath]) => {
        const layer = routeLayer(privacyRouter, routePath, method);
        assert.ok(layer, `${method.toUpperCase()} ${routePath} is registered`);
        assert.ok(layer.route.stack.length >= 2, `${routePath} has middleware and handler`);
        assert.equal(layer.route.stack[0].handle.name, 'isAuthenticated');
    });
});

// ── 2. View Compilation ─────────────────────────────────────────────
test('account/privacy.ejs compiles with representative candidate data', () => {
    const templatePath = path.join(__dirname, '..', 'views', 'account', 'privacy.ejs');
    const rawTemplate = fs.readFileSync(templatePath, 'utf8').replace("<% layout('layouts/boilerplate') %>", '');

    const candidate = {
        _id: new mongoose.Types.ObjectId(),
        name: 'Aarav Patel',
        email: 'aarav@example.com',
        role: 'candidate',
        password: 'hashedpassword'
    };

    const preview = {
        role: 'candidate',
        profileFields: 5,
        items: [
            { key: 'profile', label: 'Candidate Profile Records', count: 1 },
            { key: 'applications', label: 'Internship Applications', count: 3 }
        ]
    };

    const html = ejs.render(rawTemplate, {
        user: candidate,
        activeUser: candidate,
        blocker: null,
        preview,
        isGoogleAccount: false,
        success_msg: null,
        error_msg: null
    }, { filename: templatePath });

    assert.ok(html.includes('Privacy &amp; Data Protection Center') || html.includes('Privacy & Data Protection Center'));
    assert.ok(html.includes('Download My Data'));
    assert.ok(html.includes('Delete My Account'));
    assert.ok(html.includes('Current Account Password'));
    assert.ok(html.includes('Type <span class="font-mono text-rose-600 font-black">DELETE</span>'));
});

test('account/privacy.ejs displays Google OAuth confirmation when user has no password', () => {
    const templatePath = path.join(__dirname, '..', 'views', 'account', 'privacy.ejs');
    const rawTemplate = fs.readFileSync(templatePath, 'utf8').replace("<% layout('layouts/boilerplate') %>", '');

    const googleUser = {
        _id: new mongoose.Types.ObjectId(),
        name: 'Priya Sharma',
        email: 'priya@gmail.com',
        role: 'candidate',
        googleId: 'google-oauth-123',
        password: null
    };

    const html = ejs.render(rawTemplate, {
        user: googleUser,
        activeUser: googleUser,
        blocker: null,
        preview: { role: 'candidate', items: [] },
        isGoogleAccount: true,
        success_msg: null,
        error_msg: null
    }, { filename: templatePath });

    assert.ok(html.includes('Verify Your Registered Email Address'));
    assert.ok(html.includes('priya@gmail.com'));
});

test('account/privacy.ejs displays company owner deletion blocker warning', () => {
    const templatePath = path.join(__dirname, '..', 'views', 'account', 'privacy.ejs');
    const rawTemplate = fs.readFileSync(templatePath, 'utf8').replace("<% layout('layouts/boilerplate') %>", '');

    const companyUser = {
        _id: new mongoose.Types.ObjectId(),
        name: 'Tech Corp',
        email: 'admin@techcorp.in',
        role: 'company'
    };

    const blocker = {
        blocked: true,
        reason: 'active_listings',
        count: 2,
        items: ['Frontend Intern', 'Backend Intern'],
        message: 'You cannot delete your company account while you have 2 live internship listing(s).'
    };

    const html = ejs.render(rawTemplate, {
        user: companyUser,
        activeUser: companyUser,
        blocker,
        preview: { role: 'company', items: [] },
        isGoogleAccount: false,
        success_msg: null,
        error_msg: null
    }, { filename: templatePath });

    assert.ok(html.includes('Account Deletion Restricted'));
    assert.ok(html.includes('Manage Listings'));
    assert.ok(!html.includes('id="deleteAccountForm"'));
});

test('account/deleted.ejs compiles with confirmation message', () => {
    const templatePath = path.join(__dirname, '..', 'views', 'account', 'deleted.ejs');
    const rawTemplate = fs.readFileSync(templatePath, 'utf8').replace("<% layout('layouts/boilerplate') %>", '');

    const html = ejs.render(rawTemplate, {
        email: 'user@example.com'
    }, { filename: templatePath });

    assert.ok(html.includes('Account Successfully Closed'));
    assert.ok(html.includes('user@example.com'));
    assert.ok(html.includes('DPDP Act 2023'));
});

// ── 3. Rate Limiter ─────────────────────────────────────────────────
test('rate limiter permits requests under threshold and blocks subsequent ones', () => {
    const key = `test-user-${Date.now()}`;
    resetRateLimit(key);

    for (let i = 0; i < 3; i++) {
        const res = checkRateLimit(key, { max: 3, windowMs: 60000 });
        assert.equal(res.allowed, true);
    }

    const blocked = checkRateLimit(key, { max: 3, windowMs: 60000 });
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds > 0);

    resetRateLimit(key);
});

// ── 4. Credential Verification ──────────────────────────────────────
test('verifyDeletionCredentials validates confirmation word and password', async () => {
    const hash = await bcrypt.hash('CorrectPass123', 8);
    const user = {
        email: 'rahul@example.com',
        password: hash
    };

    // Fails on missing DELETE
    const badWord = await verifyDeletionCredentials(user, { password: 'CorrectPass123', confirmation: 'delete' });
    assert.equal(badWord.ok, false);
    assert.match(badWord.error, /DELETE/);

    // Fails on wrong password
    const wrongPass = await verifyDeletionCredentials(user, { password: 'WrongPassword', confirmation: 'DELETE' });
    assert.equal(wrongPass.ok, false);
    assert.match(wrongPass.error, /password/i);

    // Passes on correct credentials
    const success = await verifyDeletionCredentials(user, { password: 'CorrectPass123', confirmation: 'DELETE' });
    assert.equal(success.ok, true);
});

test('verifyDeletionCredentials validates Google OAuth accounts via registered email', async () => {
    const googleUser = {
        email: 'googleuser@example.com',
        googleId: '123456789',
        password: null
    };

    // Mismatched email
    const wrongEmail = await verifyDeletionCredentials(googleUser, { confirmEmail: 'wrong@example.com', confirmation: 'DELETE' });
    assert.equal(wrongEmail.ok, false);
    assert.match(wrongEmail.error, /registered email/i);

    // Matching email
    const validEmail = await verifyDeletionCredentials(googleUser, { confirmEmail: 'googleuser@example.com', confirmation: 'DELETE' });
    assert.equal(validEmail.ok, true);
});

// ── 5. Company Owner Blocker Logic ──────────────────────────────────
test('getDeletionBlocker permits candidates and team members but blocks admin', async () => {
    const candidate = { _id: new mongoose.Types.ObjectId(), role: 'candidate' };
    const recruiter = { _id: new mongoose.Types.ObjectId(), role: 'recruiter' };
    const admin = { _id: new mongoose.Types.ObjectId(), role: 'admin' };

    assert.equal(await getDeletionBlocker(candidate), null);
    assert.equal(await getDeletionBlocker(recruiter), null);

    const adminBlocker = await getDeletionBlocker(admin);
    assert.ok(adminBlocker);
    assert.equal(adminBlocker.blocked, true);
});

test('getDeletionBlocker blocks company owner if live listings or team members exist', async () => {
    const companyId = new mongoose.Types.ObjectId();
    const companyUser = { _id: companyId, role: 'company' };

    const origInternshipFind = Internship.find;
    const origUserFind = User.find;

    // Case A: Live listings exist
    Internship.find = () => ({
        select: () => ({
            lean: async () => [{ title: 'Full Stack Intern' }]
        })
    });
    User.find = () => ({
        select: () => ({
            lean: async () => []
        })
    });

    const listingBlocker = await getDeletionBlocker(companyUser);
    assert.ok(listingBlocker);
    assert.equal(listingBlocker.blocked, true);
    assert.equal(listingBlocker.reason, 'active_listings');
    assert.match(listingBlocker.message, /live internship listing/);

    // Case B: Active team members exist
    Internship.find = () => ({
        select: () => ({
            lean: async () => []
        })
    });
    User.find = () => ({
        select: () => ({
            lean: async () => [{ name: 'John Recruiter', email: 'john@example.com' }]
        })
    });

    const teamBlocker = await getDeletionBlocker(companyUser);
    assert.ok(teamBlocker);
    assert.equal(teamBlocker.blocked, true);
    assert.equal(teamBlocker.reason, 'team_members');
    assert.match(teamBlocker.message, /active team member/);

    // Case C: 0 live listings and 0 team members
    User.find = () => ({
        select: () => ({
            lean: async () => []
        })
    });

    const noBlocker = await getDeletionBlocker(companyUser);
    assert.equal(noBlocker, null);

    Internship.find = origInternshipFind;
    User.find = origUserFind;
});

// ── 6. Data Export (Portability & Scoping) ───────────────────────────
test('buildUserDataExport omits hashed password and scopes data to user', async () => {
    const userId = new mongoose.Types.ObjectId();
    const candidate = {
        _id: userId,
        name: 'Arjun Sen',
        email: 'arjun@example.com',
        password: 'SUPER_SECRET_HASHED_PASSWORD',
        role: 'candidate',
        age: 23,
        location: { district: 'Bengaluru', state: 'Karnataka' },
        skills: ['Node.js', 'React'],
        skillProfiles: [{ name: 'Node.js', proficiency: 'Advanced' }],
        savedInternships: [],
        createdAt: new Date('2026-01-15')
    };

    // Stubs
    const origAppFind = Application.find;
    const origSavedSearchFind = SavedSearch.find;
    const origInternshipFind = Internship.find;
    const origConvFind = Conversation.find;
    const origMsgFind = Message.find;
    const origNotifFind = Notification.find;
    const origGrievanceFind = Grievance.find;
    const origMockFind = MockInterviewSession.find;
    const origProblemFind = ResumeProblemSet.find;
    const origResumeParseFindOne = ResumeParse.findOne;
    const origCertFind = Certificate.find;
    const origReviewFind = Review.find;

    Application.find = () => ({
        populate: () => ({
            lean: async () => [{
                _id: new mongoose.Types.ObjectId(),
                status: 'Under Review',
                internship: { title: 'Backend Intern', companyName: 'Acme Corp' }
            }]
        })
    });
    SavedSearch.find = () => ({
        select: () => ({
            lean: async () => [{ title: 'Remote Node.js' }]
        })
    });
    Internship.find = () => ({
        select: () => ({
            lean: async () => []
        })
    });
    Conversation.find = () => ({
        populate: () => ({
            lean: async () => []
        })
    });
    Message.find = () => ({
        sort: () => ({
            lean: async () => []
        })
    });
    Notification.find = () => ({
        select: () => ({
            sort: () => ({
                limit: () => ({
                    lean: async () => [{ title: 'Application Submitted' }]
                })
            })
        })
    });
    Grievance.find = () => ({
        select: () => ({
            lean: async () => []
        })
    });
    MockInterviewSession.find = () => ({
        lean: async () => []
    });
    ResumeProblemSet.find = () => ({
        lean: async () => []
    });
    ResumeParse.findOne = () => ({
        lean: async () => null
    });
    Certificate.find = () => ({
        lean: async () => []
    });
    Review.find = () => ({
        lean: async () => []
    });

    const exportData = await buildUserDataExport(candidate);

    assert.equal(exportData.profile.password, undefined, 'Hashed password must NEVER be exported');
    assert.equal(exportData.profile.name, 'Arjun Sen');
    assert.equal(exportData.profile.email, 'arjun@example.com');
    assert.equal(exportData.exportMetadata.legalFramework, 'Digital Personal Data Protection Act, 2023 (DPDP Act, Section 11 & Section 12)');
    assert.equal(exportData.applications.length, 1);
    assert.equal(exportData.applications[0].internshipTitle, 'Backend Intern');
    assert.equal(exportData.savedSearches.length, 1);
    assert.equal(exportData.exportMetadata.summary.applicationsCount, 1);
    assert.equal(exportData.exportMetadata.summary.savedSearchesCount, 1);

    Application.find = origAppFind;
    SavedSearch.find = origSavedSearchFind;
    Internship.find = origInternshipFind;
    Conversation.find = origConvFind;
    Message.find = origMsgFind;
    Notification.find = origNotifFind;
    Grievance.find = origGrievanceFind;
    MockInterviewSession.find = origMockFind;
    ResumeProblemSet.find = origProblemFind;
    ResumeParse.findOne = origResumeParseFindOne;
    Certificate.find = origCertFind;
    Review.find = origReviewFind;
});

// ── 7. Cascading Deletion & Audit Logging ────────────────────────────
test('deleteUserAccount cascades deletion of candidate records and writes audit logs', async () => {
    const userId = new mongoose.Types.ObjectId();
    const hash = await bcrypt.hash('SecurePass123', 8);
    const candidate = {
        _id: userId,
        name: 'Neha Roy',
        email: 'neha@example.com',
        role: 'candidate',
        password: hash
    };

    // Stubs
    const origAppDeleteMany = Application.deleteMany;
    const origConvDeleteMany = Conversation.deleteMany;
    const origConvFind = Conversation.find;
    const origMsgDeleteMany = Message.deleteMany;
    const origSavedSearchDeleteMany = SavedSearch.deleteMany;
    const origAlertDeleteMany = SavedSearchAlertDelivery.deleteMany;
    const origRecDeleteMany = Recommendation.deleteMany;
    const origResumeParseDeleteMany = ResumeParse.deleteMany;
    const origMockDeleteMany = MockInterviewSession.deleteMany;
    const origProblemDeleteMany = ResumeProblemSet.deleteMany;
    const origCertDeleteMany = Certificate.deleteMany;
    const origReviewDeleteMany = Review.deleteMany;
    const origNotifDeleteMany = Notification.deleteMany;
    const origGrievanceDeleteMany = Grievance.deleteMany;
    const origSuspensionDeleteMany = AccountSuspension.deleteMany;
    const origUserDeleteOne = User.deleteOne;
    const origAuditCreate = AdminAuditLog.create;
    const origAdminActionCreate = AdminAction.create;

    Application.deleteMany = async (filter) => {
        assert.equal(String(filter.candidate), String(userId));
        return { deletedCount: 2 };
    };
    Conversation.find = () => ({
        select: () => ({
            lean: async () => [{ _id: new mongoose.Types.ObjectId() }]
        })
    });
    Message.deleteMany = async () => ({ deletedCount: 5 });
    Conversation.deleteMany = async (filter) => {
        assert.equal(String(filter.candidate), String(userId));
        return { deletedCount: 1 };
    };
    SavedSearch.deleteMany = async (filter) => {
        assert.equal(String(filter.candidate), String(userId));
        return { deletedCount: 1 };
    };
    SavedSearchAlertDelivery.deleteMany = async (filter) => {
        assert.equal(String(filter.candidate), String(userId));
        return { deletedCount: 0 };
    };
    Recommendation.deleteMany = async (filter) => {
        assert.equal(String(filter.candidate), String(userId));
        return { deletedCount: 1 };
    };
    ResumeParse.deleteMany = async (filter) => {
        assert.equal(String(filter.user), String(userId));
        return { deletedCount: 1 };
    };
    MockInterviewSession.deleteMany = async (filter) => {
        assert.equal(String(filter.candidate), String(userId));
        return { deletedCount: 0 };
    };
    ResumeProblemSet.deleteMany = async (filter) => {
        assert.equal(String(filter.candidate), String(userId));
        return { deletedCount: 0 };
    };
    Certificate.deleteMany = async (filter) => {
        assert.equal(String(filter.candidate), String(userId));
        return { deletedCount: 0 };
    };
    Review.deleteMany = async (filter) => {
        assert.equal(String(filter.candidate), String(userId));
        return { deletedCount: 0 };
    };
    Notification.deleteMany = async (filter) => {
        assert.equal(String(filter.recipient), String(userId));
        return { deletedCount: 4 };
    };
    Grievance.deleteMany = async (filter) => {
        assert.equal(String(filter.raisedBy), String(userId));
        return { deletedCount: 0 };
    };
    AccountSuspension.deleteMany = async (filter) => {
        assert.equal(String(filter.user), String(userId));
        return { deletedCount: 0 };
    };
    User.deleteOne = async (filter) => {
        assert.equal(String(filter._id), String(userId));
        return { deletedCount: 1 };
    };

    let auditLogged = false;
    AdminAuditLog.create = async (payload) => {
        assert.equal(String(payload.actor), String(userId));
        assert.equal(payload.action, 'ACCOUNT_DELETED');
        assert.equal(payload.targetType, 'User');
        auditLogged = true;
        return payload;
    };
    AdminAction.create = async () => ({});

    const result = await deleteUserAccount(candidate, {
        password: 'SecurePass123',
        confirmation: 'DELETE'
    });

    assert.equal(result.ok, true);
    assert.equal(auditLogged, true);
    assert.equal(result.removed.user, 1);
    assert.equal(result.removed.applications, 2);

    Application.deleteMany = origAppDeleteMany;
    Conversation.find = origConvFind;
    Conversation.deleteMany = origConvDeleteMany;
    Message.deleteMany = origMsgDeleteMany;
    SavedSearch.deleteMany = origSavedSearchDeleteMany;
    SavedSearchAlertDelivery.deleteMany = origAlertDeleteMany;
    Recommendation.deleteMany = origRecDeleteMany;
    ResumeParse.deleteMany = origResumeParseDeleteMany;
    MockInterviewSession.deleteMany = origMockDeleteMany;
    ResumeProblemSet.deleteMany = origProblemDeleteMany;
    Certificate.deleteMany = origCertDeleteMany;
    Review.deleteMany = origReviewDeleteMany;
    Notification.deleteMany = origNotifDeleteMany;
    Grievance.deleteMany = origGrievanceDeleteMany;
    AccountSuspension.deleteMany = origSuspensionDeleteMany;
    User.deleteOne = origUserDeleteOne;
    AdminAuditLog.create = origAuditCreate;
    AdminAction.create = origAdminActionCreate;
});

// ── 8. Model Enum Validation ────────────────────────────────────────
test('AdminAuditLog validates DATA_EXPORTED and ACCOUNT_DELETED actions', () => {
    const id = new mongoose.Types.ObjectId();
    const exportLog = new AdminAuditLog({
        actor: id,
        action: 'DATA_EXPORTED',
        targetType: 'User',
        targetId: id
    });
    assert.equal(exportLog.validateSync(), undefined);

    const deleteLog = new AdminAuditLog({
        actor: id,
        action: 'ACCOUNT_DELETED',
        targetType: 'User',
        targetId: id
    });
    assert.equal(deleteLog.validateSync(), undefined);
});
