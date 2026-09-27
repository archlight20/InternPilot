const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ejs = require('ejs');

const { canViewPortfolio, formatPortfolioData } = require('../utils/portfolio');
const portfolioRouter = require('../routes/portfolio');

const portfolioTemplatePath = path.join(__dirname, '..', 'views', 'candidate', 'public-portfolio.ejs');
const portfolioTemplate = fs.readFileSync(portfolioTemplatePath, 'utf8');

const privateTemplatePath = path.join(__dirname, '..', 'views', 'candidate', 'portfolio-private.ejs');
const privateTemplate = fs.readFileSync(privateTemplatePath, 'utf8');

const mockCandidate = {
    _id: '507f1f77bcf86cd799439011',
    name: 'Aarav Sharma',
    email: 'aarav.sharma@example.com',
    phone: '+91 9876543210',
    role: 'candidate',
    portfolioVisibility: 'public',
    portfolioContactVisible: false,
    portfolioHeadline: 'Full Stack Developer & Open Source Contributor',
    portfolioBio: 'Passionate computer science student building high-performance web applications.',
    location: { district: 'Bengaluru Urban', state: 'Karnataka' },
    education: { qualification: 'B.Tech in Computer Science', institutionName: 'National Institute of Technology' },
    skills: ['JavaScript', 'Node.js'],
    skillProfiles: [
        { name: 'JavaScript', proficiency: 'Advanced' },
        { name: 'Node.js', proficiency: 'Intermediate' },
        { name: 'Docker', proficiency: 'Beginner' }
    ],
    projects: [
        {
            title: 'InternPilot Portal',
            description: 'AI-driven internship recommendation and verification system.',
            techStack: ['Node.js', 'Express', 'MongoDB'],
            link: 'https://github.com/example/internpilot'
        }
    ],
    certifications: [
        {
            name: 'AWS Certified Cloud Practitioner',
            issuer: 'Amazon Web Services',
            issueDate: new Date('2025-06-15'),
            link: 'https://aws.amazon.com/verification'
        }
    ],
    portfolioSocial: {
        github: 'https://github.com/aaravsharma',
        linkedin: 'https://linkedin.com/in/aaravsharma',
        twitter: 'https://twitter.com/aaravsharma',
        website: 'https://aaravsharma.dev'
    }
};

test('portfolio access control allows public visitors on public portfolios', () => {
    const publicCandidate = { ...mockCandidate, portfolioVisibility: 'public' };
    const guestAccess = canViewPortfolio(publicCandidate, null);
    assert.equal(guestAccess.allowed, true);

    const otherCandidate = { _id: '507f1f77bcf86cd799439099', role: 'candidate' };
    const otherCandidateAccess = canViewPortfolio(publicCandidate, otherCandidate);
    assert.equal(otherCandidateAccess.allowed, true);
});

test('portfolio access control restricts recruiters-only portfolios to employers and owners', () => {
    const recruiterCandidate = { ...mockCandidate, portfolioVisibility: 'recruiters' };

    // Guest visitor should be prompted to log in
    const guestAccess = canViewPortfolio(recruiterCandidate, null);
    assert.equal(guestAccess.allowed, false);
    assert.equal(guestAccess.requiresAuth, true);

    // Another candidate should be denied
    const otherCandidate = { _id: '507f1f77bcf86cd799439099', role: 'candidate' };
    const candidateAccess = canViewPortfolio(recruiterCandidate, otherCandidate);
    assert.equal(candidateAccess.allowed, false);

    // Recruiter / Company user should be allowed
    const employer = { _id: '507f1f77bcf86cd799439088', role: 'company' };
    const employerAccess = canViewPortfolio(recruiterCandidate, employer);
    assert.equal(employerAccess.allowed, true);

    // Owner should always be allowed
    const owner = { _id: '507f1f77bcf86cd799439011', role: 'candidate' };
    const ownerAccess = canViewPortfolio(recruiterCandidate, owner);
    assert.equal(ownerAccess.allowed, true);
});

test('portfolio access control restricts private portfolios to owners and admins', () => {
    const privateCandidate = { ...mockCandidate, portfolioVisibility: 'private' };

    // Unauthenticated guest
    assert.equal(canViewPortfolio(privateCandidate, null).allowed, false);

    // Company user
    const employer = { _id: '507f1f77bcf86cd799439088', role: 'company' };
    assert.equal(canViewPortfolio(privateCandidate, employer).allowed, false);

    // Owner
    const owner = { _id: '507f1f77bcf86cd799439011', role: 'candidate' };
    assert.equal(canViewPortfolio(privateCandidate, owner).allowed, true);

    // Admin
    const admin = { _id: '507f1f77bcf86cd799439077', role: 'admin' };
    assert.equal(canViewPortfolio(privateCandidate, admin).allowed, true);
});

test('formatPortfolioData correctly masks contact details when contact visibility is disabled', () => {
    const formatted = formatPortfolioData(mockCandidate, null, null, [], 'https://internpilot.in');

    assert.equal(formatted.email, null);
    assert.equal(formatted.phone, null);
    assert.equal(formatted.contactRedacted, true);
});

test('formatPortfolioData reveals contact details to employers and owners even if public contact is off', () => {
    const employer = { _id: '507f1f77bcf86cd799439088', role: 'company' };
    const formattedForEmployer = formatPortfolioData(mockCandidate, employer, null, [], 'https://internpilot.in');

    assert.equal(formattedForEmployer.email, 'aarav.sharma@example.com');
    assert.equal(formattedForEmployer.contactRedacted, false);

    const owner = { _id: '507f1f77bcf86cd799439011', role: 'candidate' };
    const formattedForOwner = formatPortfolioData(mockCandidate, owner, null, [], 'https://internpilot.in');

    assert.equal(formattedForOwner.email, 'aarav.sharma@example.com');
    assert.equal(formattedForOwner.contactRedacted, false);
});

test('formatPortfolioData groups skill proficiencies into Advanced, Intermediate, and Beginner', () => {
    const formatted = formatPortfolioData(mockCandidate, null, null, [], 'https://internpilot.in');

    assert.deepEqual(formatted.skillsByLevel.Advanced, ['JavaScript']);
    assert.deepEqual(formatted.skillsByLevel.Intermediate, ['Node.js']);
    assert.deepEqual(formatted.skillsByLevel.Beginner, ['Docker']);
    assert.equal(formatted.totalSkillsCount, 3);
});

test('formatPortfolioData enriches verified PMIS status and verified certificates', () => {
    const verificationRecord = { status: 'approved' };
    const certificates = [
        {
            certificateId: 'IP-CERT-2026-X8Y9Z0',
            internshipTitle: 'Fullstack Engineering Intern',
            companyName: 'TechNova Solutions',
            issuedAt: new Date('2026-08-30'),
            duration: '3 Months'
        }
    ];

    const formatted = formatPortfolioData(mockCandidate, null, verificationRecord, certificates, 'https://internpilot.in');

    assert.equal(formatted.isPmisVerified, true);
    assert.equal(formatted.verifiedCertificates.length, 1);
    assert.equal(formatted.verifiedCertificates[0].certificateId, 'IP-CERT-2026-X8Y9Z0');
    assert.equal(formatted.verifiedCertificates[0].verificationUrl, '/certificates/IP-CERT-2026-X8Y9Z0/view');
});

test('formatPortfolioData generates valid social share links', () => {
    const formatted = formatPortfolioData(mockCandidate, null, null, [], 'https://internpilot.in');

    assert.match(formatted.shareLinks.linkedin, /linkedin\.com\/sharing\/share-offsite/);
    assert.match(formatted.shareLinks.twitter, /twitter\.com\/intent\/tweet/);
    assert.match(formatted.shareLinks.whatsapp, /whatsapp\.com\/send/);
    assert.equal(formatted.portfolioUrl, 'https://internpilot.in/portfolio/507f1f77bcf86cd799439011');
});

test('public-portfolio.ejs template renders verified credentials, projects, and share modal', () => {
    const verificationRecord = { status: 'approved' };
    const certificates = [
        {
            certificateId: 'IP-CERT-2026-X8Y9Z0',
            internshipTitle: 'Fullstack Engineering Intern',
            companyName: 'TechNova Solutions',
            issuedAt: new Date('2026-08-30'),
            duration: '3 Months'
        }
    ];

    const portfolio = formatPortfolioData(mockCandidate, null, verificationRecord, certificates, 'https://internpilot.in');

    const html = ejs.render(portfolioTemplate, {
        portfolio,
        currentUser: null,
        pageTitle: `${portfolio.name} — Verified Portfolio`
    }, { filename: portfolioTemplatePath });

    assert.match(html, /Aarav Sharma/);
    assert.match(html, /PMIS Verified/);
    assert.match(html, /IP-CERT-2026-X8Y9Z0/);
    assert.match(html, /TechNova Solutions/);
    assert.match(html, /InternPilot Portal/);
    assert.match(html, /Advanced Proficiency/);
    assert.match(html, /shareModal/);
    assert.match(html, /copyPortfolioLink/);
});

test('portfolio-private.ejs template renders friendly access denied message', () => {
    const html = ejs.render(privateTemplate, {
        candidateName: 'Aarav Sharma',
        reason: 'This candidate portfolio is currently private.',
        currentUser: null,
        pageTitle: 'Private Portfolio'
    }, { filename: privateTemplatePath });

    assert.match(html, /Portfolio Is Private/);
    assert.match(html, /This candidate portfolio is currently private/);
    assert.match(html, /Back to Home/);
});

test('portfolio router exposes GET /portfolio/:id and POST /candidate/portfolio/settings', () => {
    const routes = portfolioRouter.stack
        .filter(layer => layer.route)
        .map(layer => ({
            path: layer.route.path,
            methods: Object.keys(layer.route.methods)
        }));

    const getPortfolio = routes.find(r => r.path === '/portfolio/:id' && r.methods.includes('get'));
    const postSettings = routes.find(r => r.path === '/candidate/portfolio/settings' && r.methods.includes('post'));

    assert.ok(getPortfolio, 'GET /portfolio/:id route is defined');
    assert.ok(postSettings, 'POST /candidate/portfolio/settings route is defined');
});
