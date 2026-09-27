const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const CandidateVerification = require('../models/CandidateVerification');
const Certificate = require('../models/Certificate');
const { isAuthenticated, authorize } = require('../middleware/auth');
const { canViewPortfolio, formatPortfolioData } = require('../utils/portfolio');

/**
 * GET /portfolio/:id
 * Publicly accessible candidate portfolio and verified credential showcase.
 */
router.get('/portfolio/:id', async (req, res) => {
    try {
        const candidateId = req.params.id;

        if (!mongoose.Types.ObjectId.isValid(candidateId)) {
            if (req.flash) req.flash('error_msg', 'Invalid portfolio identifier.');
            return res.status(404).render('extras/error', {
                message: 'Candidate portfolio not found. Please verify the URL and try again.',
                error: {}
            });
        }

        const candidate = await User.findOne({ _id: candidateId, role: 'candidate' });

        if (!candidate) {
            if (req.flash) req.flash('error_msg', 'Candidate portfolio not found.');
            return res.status(404).render('extras/error', {
                message: 'The requested candidate portfolio could not be found.',
                error: {}
            });
        }

        const access = canViewPortfolio(candidate, req.user);

        if (!access.allowed) {
            if (access.requiresAuth) {
                if (req.session) {
                    req.session.returnTo = req.originalUrl;
                }
                if (req.flash) req.flash('error_msg', access.reason);
                return res.redirect('/auth/login');
            }

            return res.status(403).render('candidate/portfolio-private', {
                candidateName: candidate.name || 'Candidate',
                reason: access.reason,
                currentUser: req.user,
                pageTitle: 'Private Portfolio'
            });
        }

        // Fetch verification and verified certificates in parallel
        const [verificationRecord, certificates] = await Promise.all([
            CandidateVerification.findOne({ candidate: candidate._id }).select('status').lean(),
            Certificate.find({ candidate: candidate._id, status: 'Issued' }).sort({ issuedAt: -1 }).lean()
        ]);

        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const portfolio = formatPortfolioData(candidate, req.user, verificationRecord, certificates, baseUrl);

        res.render('candidate/public-portfolio', {
            portfolio,
            currentUser: req.user,
            pageTitle: `${portfolio.name} — Verified Portfolio`
        });
    } catch (error) {
        console.error('Error fetching candidate portfolio:', error);
        res.status(500).render('extras/error', {
            message: 'Unable to load candidate portfolio at this time.',
            error: process.env.NODE_ENV === 'development' ? error : {}
        });
    }
});

/**
 * POST /candidate/portfolio/settings
 * Updates portfolio visibility, headline, bio, contact privacy, and social links.
 */
router.post('/candidate/portfolio/settings', isAuthenticated, authorize('candidate'), async (req, res) => {
    try {
        const {
            portfolioVisibility,
            portfolioContactVisible,
            portfolioHeadline,
            portfolioBio,
            github,
            linkedin,
            twitter,
            website
        } = req.body;

        const candidate = await User.findById(req.user._id);
        if (!candidate) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        if (['public', 'recruiters', 'private'].includes(portfolioVisibility)) {
            candidate.portfolioVisibility = portfolioVisibility;
        }

        candidate.portfolioContactVisible = portfolioContactVisible === 'true' || portfolioContactVisible === true;

        if (typeof portfolioHeadline === 'string') {
            candidate.portfolioHeadline = portfolioHeadline.trim().slice(0, 200);
        }

        if (typeof portfolioBio === 'string') {
            candidate.portfolioBio = portfolioBio.trim().slice(0, 2000);
        }

        candidate.portfolioSocial = {
            github: typeof github === 'string' ? github.trim().slice(0, 300) : '',
            linkedin: typeof linkedin === 'string' ? linkedin.trim().slice(0, 300) : '',
            twitter: typeof twitter === 'string' ? twitter.trim().slice(0, 300) : '',
            website: typeof website === 'string' ? website.trim().slice(0, 300) : ''
        };

        await candidate.save();

        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.json({
                success: true,
                message: 'Portfolio settings updated successfully.',
                portfolioUrl: `/portfolio/${candidate._id}`
            });
        }

        if (req.flash) req.flash('success_msg', 'Portfolio privacy and settings updated successfully.');
        res.redirect('/candidate/profile');
    } catch (error) {
        console.error('Error updating portfolio settings:', error);
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(500).json({ success: false, message: 'Failed to update portfolio settings.' });
        }
        if (req.flash) req.flash('error_msg', 'Failed to update portfolio settings.');
        res.redirect('/candidate/profile');
    }
});

module.exports = router;
