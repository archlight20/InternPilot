const express = require('express');
const router = express.Router();

const User = require('../models/User');
const AdminAuditLog = require('../models/AdminAuditLog');
const { logAdminAction } = require('../utils/adminAudit');
const { isAuthenticated } = require('../middleware/auth');
const {
    checkRateLimit,
    getDeletionBlocker,
    getPersonalDataPreview,
    buildUserDataExport,
    deleteUserAccount
} = require('../utils/privacy');

/**
 * GET /account/privacy
 * Renders the Privacy & Data Protection Center.
 */
router.get('/account/privacy', isAuthenticated, async (req, res) => {
    try {
        const userId = req.user._id || req.user.id;
        const user = await User.findById(userId);

        if (!user) {
            req.flash('error_msg', 'User account not found.');
            return res.redirect('/');
        }

        const [blocker, preview] = await Promise.all([
            getDeletionBlocker(user),
            getPersonalDataPreview(user)
        ]);

        const isGoogleAccount = !user.password || Boolean(user.googleId);

        return res.render('account/privacy', {
            user,
            activeUser: user,
            candidate: user.role === 'candidate' ? user : null,
            company: user.role === 'company' ? user : null,
            blocker,
            preview,
            isGoogleAccount,
            pageTitle: 'Privacy & Data Protection Center'
        });
    } catch (err) {
        console.error('Error rendering privacy center:', err);
        req.flash('error_msg', 'Unable to load privacy center. Please try again later.');
        return res.redirect('/');
    }
});

/**
 * GET /account/privacy/download
 * Rate-limited download of personal data as a single JSON file.
 */
router.get('/account/privacy/download', isAuthenticated, async (req, res) => {
    try {
        const userId = req.user._id || req.user.id;
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).send('User not found.');
        }

        // Rate limit: 5 downloads per 15 minutes
        const rateCheck = checkRateLimit(`download:${userId}`, { max: 5, windowMs: 15 * 60 * 1000 });
        if (!rateCheck.allowed) {
            const minutesLeft = Math.ceil(rateCheck.retryAfterSeconds / 60);
            if (req.accepts('json') && !req.accepts('html')) {
                return res.status(429).json({
                    error: `Download rate limit exceeded. Please wait ${minutesLeft} minute(s) before trying again.`
                });
            }
            req.flash('error_msg', `Download rate limit reached. Please wait ${minutesLeft} minute(s) before exporting data again.`);
            return res.redirect('/account/privacy');
        }

        const exportData = await buildUserDataExport(user);

        // Audit Logging
        try {
            await AdminAuditLog.create({
                actor: user._id,
                action: 'DATA_EXPORTED',
                targetType: 'User',
                targetId: user._id,
                reason: 'Data Principal exported personal data archive under DPDP Act 2023',
                metadata: {
                    role: user.role,
                    email: user.email,
                    summary: exportData.exportMetadata.summary
                }
            });
        } catch (auditErr) {
            console.error('Failed to log to AdminAuditLog on data export:', auditErr.message);
        }

        try {
            await logAdminAction(user, {
                action: 'user.data_export',
                targetType: 'user',
                targetId: user._id,
                targetLabel: `${user.name || 'User'} <${user.email || ''}>`,
                reason: 'Data Principal exported personal data archive under DPDP Act 2023',
                details: exportData.exportMetadata.summary
            });
        } catch (auditErr) {
            console.error('Failed to log to AdminAction on data export:', auditErr.message);
        }

        const cleanName = String(user.name || 'account').toLowerCase().replace(/[^a-z0-9]/g, '_');
        const filename = `internpilot-data-${cleanName}-${new Date().toISOString().slice(0, 10)}.json`;

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(JSON.stringify(exportData, null, 2));
    } catch (err) {
        console.error('Error exporting user data:', err);
        req.flash('error_msg', 'Failed to generate data archive. Please try again.');
        return res.redirect('/account/privacy');
    }
});

/**
 * POST /account/privacy/delete
 * Permanently erases account and all associated personal data.
 */
router.post('/account/privacy/delete', isAuthenticated, async (req, res) => {
    try {
        const userId = req.user._id || req.user.id;
        const user = await User.findById(userId);

        if (!user) {
            req.flash('error_msg', 'Account not found.');
            return res.redirect('/');
        }

        // Rate limit deletion attempts: 5 per 15 minutes
        const rateCheck = checkRateLimit(`delete:${userId}`, { max: 5, windowMs: 15 * 60 * 1000 });
        if (!rateCheck.allowed) {
            const minutesLeft = Math.ceil(rateCheck.retryAfterSeconds / 60);
            if (req.accepts('json') && !req.accepts('html')) {
                return res.status(429).json({
                    error: `Too many deletion attempts. Please wait ${minutesLeft} minute(s) before trying again.`
                });
            }
            req.flash('error_msg', `Too many deletion attempts. Please wait ${minutesLeft} minute(s) before trying again.`);
            return res.redirect('/account/privacy');
        }

        const deletionResult = await deleteUserAccount(user, req.body);

        if (!deletionResult.ok) {
            if (req.accepts('json') && !req.accepts('html')) {
                return res.status(400).json({ error: deletionResult.error });
            }
            req.flash('error_msg', deletionResult.error);
            return res.redirect('/account/privacy');
        }

        const email = user.email;

        // Sign out everywhere and clear session
        if (typeof req.logout === 'function') {
            req.logout(err => {
                if (req.session) {
                    req.session.destroy(() => {
                        res.clearCookie('connect.sid');
                        if (req.accepts('json') && !req.accepts('html')) {
                            return res.json({ ok: true, removed: deletionResult.removed });
                        }
                        return res.render('account/deleted', { email });
                    });
                } else {
                    res.clearCookie('connect.sid');
                    if (req.accepts('json') && !req.accepts('html')) {
                        return res.json({ ok: true, removed: deletionResult.removed });
                    }
                    return res.render('account/deleted', { email });
                }
            });
        } else {
            if (req.session) {
                req.session.destroy(() => {
                    res.clearCookie('connect.sid');
                    return res.render('account/deleted', { email });
                });
            } else {
                return res.render('account/deleted', { email });
            }
        }
    } catch (err) {
        console.error('Error during account deletion:', err);
        req.flash('error_msg', 'An unexpected error occurred while deleting your account. Please try again.');
        return res.redirect('/account/privacy');
    }
});

module.exports = router;
