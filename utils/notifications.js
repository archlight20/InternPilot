const Notification = require('../models/Notification');
const User = require('../models/User');
const Internship = require('../models/Internship');
const Application = require('../models/Application');
const SavedSearch = require('../models/SavedSearch');
const { skillNames } = require('./skillProfiles');
const {
    matchesInternshipCriteria,
    buildSavedSearchResultsUrl
} = require('./queryHelper');
const { sendSavedSearchAlertEmail } = require('./sendEmail');

function normalise(value) {
    return (value || '').trim().toLowerCase();
}

function hasLocationMatch(candidate, internship) {
    const candidateDistrict = normalise(candidate.location?.district);
    const candidateState = normalise(candidate.location?.state);
    const internshipDistrict = normalise(internship.location?.district);
    const internshipState = normalise(internship.location?.state);

    // Do not exclude candidates with incomplete profiles. When both sides
    // contain a location, a district match is preferred, then a state match.
    if ((!candidateDistrict && !candidateState) || (!internshipDistrict && !internshipState)) {
        return true;
    }

    if (candidateDistrict && internshipDistrict) {
        return candidateDistrict === internshipDistrict;
    }

    return !candidateState || !internshipState || candidateState === internshipState;
}

function hasQualificationMatch(candidate, internship) {
    const requirement = normalise(internship.minQualifications);
    const qualification = normalise(candidate.education?.qualification);

    if (!requirement || requirement === 'any' || !qualification) return true;
    return requirement.includes(qualification) || qualification.includes(requirement);
}

function hasSkillMatch(candidate, internship) {
    const requiredSkills = (internship.requiredSkills || []).map(normalise).filter(Boolean);
    if (!requiredSkills.length) return true;

    const candidateSkills = new Set(skillNames(candidate).map(normalise).filter(Boolean));
    return requiredSkills.some(skill => candidateSkills.has(skill));
}

function isRelevantInternship(candidate, internship) {
    return hasSkillMatch(candidate, internship)
        && hasLocationMatch(candidate, internship)
        && hasQualificationMatch(candidate, internship);
}

function isOpenPublishedInternship(internship, now = new Date()) {
    if (!internship || internship.status !== 'published' || internship.isPaused === true) return false;
    if (!internship.applicationDeadline) return true;
    const deadline = new Date(internship.applicationDeadline);
    return Number.isNaN(deadline.getTime()) || deadline.getTime() >= now.getTime();
}

function identifier(value) {
    return value && value._id ? String(value._id) : String(value || '');
}

function addSavedSearchMatch(groups, candidate, savedSearch) {
    const key = identifier(candidate);
    if (!key) return;
    const group = groups.get(key) || { candidate, matches: [] };
    group.matches.push(savedSearch);
    groups.set(key, group);
}

async function notifyRelevantCandidates(internship) {
    const now = new Date();
    // A draft, closed, paused, or expired listing must never produce an alert.
    if (!isOpenPublishedInternship(internship, now)) return 0;

    const [candidates, savedSearches] = await Promise.all([
        User.find({ role: 'candidate', isEmailVerified: true, isActive: true })
            .select('_id name email skills skillProfiles location education')
            .lean(),
        SavedSearch.find({ isPaused: false, frequency: { $ne: 'off' } }).lean()
    ]);

    const candidatesById = new Map(candidates.map(candidate => [identifier(candidate), candidate]));
    const profileMatches = new Set(
        candidates.filter(candidate => isRelevantInternship(candidate, internship)).map(identifier)
    );
    const savedMatchesByCandidate = new Map();

    savedSearches.forEach(savedSearch => {
        const candidate = candidatesById.get(identifier(savedSearch.candidate));
        if (!candidate || !matchesInternshipCriteria(internship, savedSearch.criteria, now)) return;
        addSavedSearchMatch(savedMatchesByCandidate, candidate, savedSearch);
    });

    // Group by candidate so profile matching and multiple saved searches never
    // produce duplicate in-app notifications for one published listing.
    const immediateRecipients = new Map();
    profileMatches.forEach(candidateId => {
        const candidate = candidatesById.get(candidateId);
        if (candidate) immediateRecipients.set(candidateId, { candidate, savedMatches: [], profileMatch: true });
    });

    const inAppSavedSearchIds = [];
    savedMatchesByCandidate.forEach((group, candidateId) => {
        const instantInAppMatches = group.matches.filter(search =>
            search.frequency === 'instant' && search.delivery?.inApp !== false
        );
        if (!instantInAppMatches.length) return;

        const recipient = immediateRecipients.get(candidateId) || {
            candidate: group.candidate,
            savedMatches: [],
            profileMatch: false
        };
        recipient.savedMatches.push(...instantInAppMatches);
        immediateRecipients.set(candidateId, recipient);
        inAppSavedSearchIds.push(...instantInAppMatches.map(search => search._id));
    });

    if (immediateRecipients.size) {
        const operations = [...immediateRecipients.values()].map(({ candidate, savedMatches, profileMatch }) => {
            const savedNames = [...new Set(savedMatches.map(search => search.name).filter(Boolean))];
            const matchMessage = profileMatch
                ? `${internship.title} at ${internship.companyName} matches your profile.`
                : `${internship.title} at ${internship.companyName} matches your saved search${savedNames.length === 1 ? ` “${savedNames[0]}”` : 'es'}.`;

            return {
                updateOne: {
                    filter: {
                        recipient: candidate._id,
                        internship: internship._id,
                        type: 'new_matching_internship'
                    },
                    update: {
                        $setOnInsert: {
                            recipient: candidate._id,
                            type: 'new_matching_internship',
                            title: 'New internship match',
                            message: matchMessage,
                            link: savedMatches.length ? buildSavedSearchResultsUrl(savedMatches[0].criteria) : '/internships',
                            internship: internship._id,
                            isRead: false
                        }
                    },
                    upsert: true
                }
            };
        });

        await Notification.bulkWrite(operations, { ordered: false });
    }

    // Email-only and "both" instant alerts are sent once per candidate/listing
    // even when more than one saved search matches.
    const emailSearchIds = [];
    const emailRecipients = [...savedMatchesByCandidate.values()].map(async group => {
        const matchingSearches = group.matches.filter(search =>
            search.frequency === 'instant' && search.delivery?.email === true
        );
        if (!matchingSearches.length || !group.candidate.email) return;

        try {
            await sendSavedSearchAlertEmail(
                group.candidate.email,
                group.candidate.name,
                matchingSearches.map(search => search.name),
                [internship],
                'instant',
                buildSavedSearchResultsUrl(matchingSearches[0].criteria)
            );
            emailSearchIds.push(...matchingSearches.map(search => search._id));
        } catch (error) {
            // E-mail delivery must not make publishing an internship fail; the
            // in-app notification remains available when the candidate chose it.
            console.error('Failed to send saved-search instant alert:', error.message);
        }
    });
    await Promise.all(emailRecipients);

    const deliveredSearchIds = [...new Set([...inAppSavedSearchIds, ...emailSearchIds].map(identifier).filter(Boolean))];
    if (deliveredSearchIds.length) {
        await SavedSearch.updateMany(
            { _id: { $in: deliveredSearchIds } },
            { $set: { lastAlertAt: now } }
        );
    }

    const alertedCandidateIds = new Set([
        ...immediateRecipients.keys(),
        ...[...savedMatchesByCandidate.entries()]
            .filter(([, group]) => group.matches.some(search => search.frequency === 'instant' && search.delivery?.email === true))
            .map(([candidateId]) => candidateId)
    ]);
    return alertedCandidateIds.size;
}

function timestampFromInternship(internship) {
    if (internship?.createdAt) {
        const value = new Date(internship.createdAt);
        if (!Number.isNaN(value.getTime())) return value;
    }
    if (internship?._id && typeof internship._id.getTimestamp === 'function') return internship._id.getTimestamp();
    return null;
}

function digestKey(frequency, now) {
    const date = new Date(now);
    return `${frequency}:${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Delivers a candidate-level digest for daily or weekly saved searches. It is
 * exported so scheduler behavior can be exercised without waiting for cron.
 *
 * @param {'daily'|'weekly'} frequency
 * @param {Date} [now]
 * @returns {Promise<number>} number of candidate digests created
 */
async function runSavedSearchDigests(frequency, now = new Date()) {
    if (!['daily', 'weekly'].includes(frequency)) return 0;

    const [savedSearches, internships] = await Promise.all([
        SavedSearch.find({ frequency, isPaused: false }).lean(),
        Internship.find({
            status: 'published',
            isPaused: { $ne: true },
            $or: [
                { applicationDeadline: { $exists: false } },
                { applicationDeadline: null },
                { applicationDeadline: { $gte: now } }
            ]
        }).lean()
    ]);
    if (!savedSearches.length) return 0;

    const candidateIds = [...new Set(savedSearches.map(search => identifier(search.candidate)).filter(Boolean))];
    const candidates = await User.find({
        _id: { $in: candidateIds },
        role: 'candidate',
        isEmailVerified: true,
        isActive: true
    }).select('_id name email').lean();
    const candidatesById = new Map(candidates.map(candidate => [identifier(candidate), candidate]));
    const allInternshipIds = internships.map(internship => internship._id);
    const applications = allInternshipIds.length
        ? await Application.find({
            candidate: { $in: candidateIds },
            internship: { $in: allInternshipIds }
        }).select('candidate internship').lean()
        : [];
    const appliedByCandidate = new Map();
    applications.forEach(application => {
        const candidateId = identifier(application.candidate);
        const applied = appliedByCandidate.get(candidateId) || new Set();
        applied.add(identifier(application.internship));
        appliedByCandidate.set(candidateId, applied);
    });

    const grouped = new Map();
    savedSearches.forEach(savedSearch => {
        const candidate = candidatesById.get(identifier(savedSearch.candidate));
        if (!candidate) return;
        const since = new Date(savedSearch.lastDigestAt || savedSearch.alertStartAt || savedSearch.createdAt || now);
        const safeSince = Number.isNaN(since.getTime()) ? now : since;
        const alreadyApplied = appliedByCandidate.get(identifier(candidate)) || new Set();
        const matches = internships.filter(internship => {
            const publishedAt = timestampFromInternship(internship);
            return publishedAt && publishedAt.getTime() > safeSince.getTime()
                && !alreadyApplied.has(identifier(internship))
                && matchesInternshipCriteria(internship, savedSearch.criteria, now);
        });
        if (!matches.length) return;

        const candidateId = identifier(candidate);
        const entry = grouped.get(candidateId) || { candidate, searches: [] };
        entry.searches.push({ savedSearch, matches });
        grouped.set(candidateId, entry);
    });

    let delivered = 0;
    for (const { candidate, searches } of grouped.values()) {
        const searchNames = [...new Set(searches.map(entry => entry.savedSearch.name).filter(Boolean))];
        const internshipsForDigest = [...new Map(
            searches.flatMap(entry => entry.matches).map(internship => [identifier(internship), internship])
        ).values()];
        const wantsInApp = searches.some(entry => entry.savedSearch.delivery?.inApp !== false);
        const wantsEmail = searches.some(entry => entry.savedSearch.delivery?.email === true);
        const message = `${internshipsForDigest.length} new internship${internshipsForDigest.length === 1 ? '' : 's'} match your ${frequency} saved searches.`;
        const key = digestKey(frequency, now);

        if (wantsInApp) {
            await Notification.updateOne(
                {
                    recipient: candidate._id,
                    type: 'saved_search_digest',
                    'metadata.digestKey': key
                },
                {
                    $setOnInsert: {
                        recipient: candidate._id,
                        type: 'saved_search_digest',
                        title: `${frequency[0].toUpperCase()}${frequency.slice(1)} internship matches`,
                        message,
                        link: '/candidate/saved-searches',
                        metadata: {
                            digestKey: key,
                            internshipCount: internshipsForDigest.length,
                            searchNames
                        },
                        isRead: false
                    }
                },
                { upsert: true }
            );
        }

        if (wantsEmail && candidate.email) {
            try {
                await sendSavedSearchAlertEmail(
                    candidate.email,
                    candidate.name,
                    searchNames,
                    internshipsForDigest,
                    frequency,
                    '/candidate/saved-searches'
                );
            } catch (error) {
                console.error('Failed to send saved-search digest:', error.message);
            }
        }

        if (wantsInApp || wantsEmail) delivered += 1;
    }

    // Move each requested digest window forward even when no listing matched;
    // this prevents a future run from scanning the same historical window.
    await SavedSearch.updateMany(
        { _id: { $in: savedSearches.map(search => search._id) } },
        { $set: { lastDigestAt: now } }
    );
    return delivered;
}

async function notifyApplicationStatusChange(application, internship, status) {
    const isShortlisted = status === 'Shortlisted';

    await Notification.create({
        recipient: application.candidate._id || application.candidate,
        type: isShortlisted ? 'application_shortlisted' : 'application_status',
        title: isShortlisted ? 'You have been shortlisted!' : 'Application status updated',
        message: isShortlisted
            ? `You have been shortlisted for ${internship.title} at ${internship.companyName}.`
            : `Your application for ${internship.title} at ${internship.companyName} is now ${status}.`,
        link: '/candidate/applications',
        internship: internship._id,
        application: application._id
    });
}

async function notifyInterviewScheduled(application, internship, dateString) {
    await Notification.create({
        recipient: application.candidate._id || application.candidate,
        type: 'interview_scheduled',
        title: 'Interview Scheduled',
        message: `An interview for ${internship.title} at ${internship.companyName} has been scheduled for ${dateString}.`,
        link: '/candidate/applications',
        internship: internship._id,
        application: application._id
    });
}

async function notifyInterviewRescheduled(application, internship, dateString) {
    await Notification.create({
        recipient: application.candidate._id || application.candidate,
        type: 'interview_rescheduled',
        title: 'Interview Rescheduled',
        message: `Your interview for ${internship.title} at ${internship.companyName} has been rescheduled to ${dateString}.`,
        link: '/candidate/applications',
        internship: internship._id,
        application: application._id
    });
}

async function notifyInterviewCancelled(application, internship) {
    await Notification.create({
        recipient: application.candidate._id || application.candidate,
        type: 'interview_cancelled',
        title: 'Interview Cancelled',
        message: `Your interview for ${internship.title} at ${internship.companyName} has been cancelled.`,
        link: '/candidate/applications',
        internship: internship._id,
        application: application._id
    });
}

module.exports = {
    isRelevantInternship,
    notifyRelevantCandidates,
    runSavedSearchDigests,
    notifyApplicationStatusChange,
    notifyInterviewScheduled,
    notifyInterviewRescheduled,
    notifyInterviewCancelled
};
