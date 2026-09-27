const { isSafeHttpUrl, sanitizeHttpUrl } = require('./safeUrl');

/**
 * Checks whether a viewer has permission to access a candidate's portfolio.
 * 
 * @param {Object} candidate - The candidate User document
 * @param {Object|null} viewer - The currently authenticated User (or null/undefined)
 * @returns {{ allowed: boolean, requiresAuth?: boolean, reason?: string }}
 */
function canViewPortfolio(candidate, viewer = null) {
    if (!candidate) {
        return { allowed: false, reason: 'Candidate not found.' };
    }

    const visibility = candidate.portfolioVisibility || 'public';
    const isOwner = Boolean(viewer && String(viewer._id) === String(candidate._id));
    const isAdmin = Boolean(viewer && viewer.role === 'admin');
    const isEmployer = Boolean(viewer && (viewer.role === 'company' || isAdmin));

    // Owner and Admin can always view
    if (isOwner || isAdmin) {
        return { allowed: true };
    }

    // Public portfolio: Anyone can view
    if (visibility === 'public') {
        return { allowed: true };
    }

    // Recruiters-only portfolio
    if (visibility === 'recruiters') {
        if (isEmployer) {
            return { allowed: true };
        }
        if (!viewer) {
            return {
                allowed: false,
                requiresAuth: true,
                reason: 'This portfolio is visible to verified employers only. Please log in to view.'
            };
        }
        return {
            allowed: false,
            reason: 'This portfolio is only accessible to verified company recruiters.'
        };
    }

    // Private portfolio
    return {
        allowed: false,
        reason: 'This candidate portfolio is currently private.'
    };
}

/**
 * Formats and sanitizes candidate data for public portfolio display.
 * Redacts personal contact information according to candidate privacy preferences.
 * 
 * @param {Object} candidate - Candidate User document
 * @param {Object|null} viewer - Authenticated User viewing the page
 * @param {Object|null} verificationRecord - CandidateVerification record (if any)
 * @param {Array} certificates - List of issued Certificate records
 * @param {string} baseUrl - Base host URL for share links
 * @returns {Object} Clean portfolio view model
 */
function formatPortfolioData(candidate, viewer = null, verificationRecord = null, certificates = [], baseUrl = '') {
    const isOwner = Boolean(viewer && String(viewer._id) === String(candidate._id));
    const isEmployer = Boolean(viewer && (viewer.role === 'company' || viewer.role === 'admin'));
    const showContact = Boolean(candidate.portfolioContactVisible || isOwner || isEmployer);

    // Group skills by proficiency level
    const skillsByLevel = {
        Advanced: [],
        Intermediate: [],
        Beginner: []
    };

    if (Array.isArray(candidate.skillProfiles) && candidate.skillProfiles.length > 0) {
        candidate.skillProfiles.forEach(item => {
            const level = item.proficiency || 'Intermediate';
            if (skillsByLevel[level]) {
                skillsByLevel[level].push(item.name);
            } else {
                skillsByLevel.Intermediate.push(item.name);
            }
        });
    } else if (Array.isArray(candidate.skills)) {
        // Fallback to legacy string array
        candidate.skills.forEach(skillName => {
            skillsByLevel.Intermediate.push(skillName);
        });
    }

    // Sanitize and format projects
    const projects = (candidate.projects || []).map(p => ({
        title: p.title || '',
        description: p.description || '',
        techStack: Array.isArray(p.techStack) ? p.techStack : [],
        link: p.link && isSafeHttpUrl(p.link) ? p.link : '',
        fileName: p.fileName || '',
        fileUrl: p.fileUrl || ''
    }));

    // Sanitize and format certifications
    const certifications = (candidate.certifications || []).map(c => ({
        name: c.name || '',
        issuer: c.issuer || '',
        issueDate: c.issueDate ? new Date(c.issueDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : null,
        link: c.link && isSafeHttpUrl(c.link) ? c.link : ''
    }));

    // Format verified certificates
    const verifiedCertificates = (certificates || []).map(cert => ({
        certificateId: cert.certificateId,
        internshipTitle: cert.internshipTitle,
        companyName: cert.companyName,
        issuedAt: cert.issuedAt ? new Date(cert.issuedAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : '',
        duration: cert.duration || '',
        verificationUrl: `/certificates/${cert.certificateId}/view`
    }));

    // PMIS & Identity Verification Status
    const isPmisVerified = Boolean(verificationRecord && verificationRecord.status === 'approved');

    // Location display
    let locationDisplay = 'Location Not Provided';
    if (candidate.location) {
        if (typeof candidate.location === 'object') {
            const parts = [candidate.location.district, candidate.location.state].filter(Boolean);
            if (parts.length > 0) locationDisplay = parts.join(', ');
        } else if (typeof candidate.location === 'string' && candidate.location.trim()) {
            locationDisplay = candidate.location.trim();
        }
    }

    // Education display
    const qualification = candidate.education?.qualification || '';
    const institution = candidate.education?.institutionName || candidate.institution || '';

    // Clean social links
    const social = {
        github: candidate.portfolioSocial?.github && isSafeHttpUrl(candidate.portfolioSocial.github) ? candidate.portfolioSocial.github : '',
        linkedin: candidate.portfolioSocial?.linkedin && isSafeHttpUrl(candidate.portfolioSocial.linkedin) ? candidate.portfolioSocial.linkedin : '',
        twitter: candidate.portfolioSocial?.twitter && isSafeHttpUrl(candidate.portfolioSocial.twitter) ? candidate.portfolioSocial.twitter : '',
        website: candidate.portfolioSocial?.website && isSafeHttpUrl(candidate.portfolioSocial.website) ? candidate.portfolioSocial.website : ''
    };

    // Public portfolio URL
    const portfolioUrl = `${baseUrl}/portfolio/${candidate._id}`;

    // Social share links
    const encodedUrl = encodeURIComponent(portfolioUrl);
    const encodedTitle = encodeURIComponent(`Explore ${candidate.name || 'Candidate'}'s Verified Internship Portfolio on InternPilot`);
    const shareLinks = {
        linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
        twitter: `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedTitle}`,
        whatsapp: `https://api.whatsapp.com/send?text=${encodedTitle}%20${encodedUrl}`
    };

    return {
        id: candidate._id,
        name: candidate.name || 'Candidate',
        headline: candidate.portfolioHeadline || qualification || 'Aspiring Professional',
        bio: candidate.portfolioBio || '',
        qualification,
        institution,
        location: locationDisplay,
        email: showContact ? candidate.email : null,
        phone: showContact ? candidate.phone : null,
        contactRedacted: !showContact,
        isPmisVerified,
        verifiedCertificates,
        skillsByLevel,
        totalSkillsCount: (skillsByLevel.Advanced.length + skillsByLevel.Intermediate.length + skillsByLevel.Beginner.length),
        projects,
        certifications,
        social,
        portfolioUrl,
        shareLinks,
        visibility: candidate.portfolioVisibility || 'public',
        isOwner,
        isEmployer
    };
}

module.exports = {
    canViewPortfolio,
    formatPortfolioData
};
