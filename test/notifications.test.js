const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isRelevantInternship,
    notifyRelevantCandidates,
    mapWithConcurrency,
    publicationTimestampFromInternship,
    shouldAdvanceDigestCheckpoint
} = require('../utils/notifications');

const matchingCandidate = {
    skills: ['JavaScript', 'MongoDB'],
    location: { district: 'Pune', state: 'Maharashtra' },
    education: { qualification: 'B.Tech' }
};

const matchingInternship = {
    status: 'published',
    requiredSkills: ['javascript'],
    location: { district: 'Pune', state: 'Maharashtra' },
    minQualifications: 'B.Tech'
};

test('recognises a relevant internship using normalized skills, location, and qualification', () => {
    assert.equal(isRelevantInternship(matchingCandidate, matchingInternship), true);
    assert.equal(
        isRelevantInternship(matchingCandidate, {
            ...matchingInternship,
            requiredSkills: ['Python']
        }),
        false
    );
});

test('does not query candidates for draft or closed internships', async () => {
    assert.equal(await notifyRelevantCandidates({ status: 'draft' }), 0);
    assert.equal(await notifyRelevantCandidates({ status: 'closed' }), 0);
});

test('bounds concurrent instant-alert work while preserving result order', async () => {
    let inFlight = 0;
    let maximumInFlight = 0;
    const values = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async value => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight -= 1;
        return value * 2;
    });

    assert.deepEqual(values, [2, 4, 6, 8, 10, 12, 14]);
    assert.ok(maximumInFlight <= 3);
});

test('uses publication time before legacy creation time for digest matching', () => {
    const timestamp = publicationTimestampFromInternship({
        publishedAt: '2026-09-26T09:00:00.000Z',
        createdAt: '2026-09-20T09:00:00.000Z'
    });

    assert.equal(timestamp.toISOString(), '2026-09-26T09:00:00.000Z');
});

test('keeps an email-only digest window open when e-mail delivery fails', () => {
    const emailOnly = { delivery: { inApp: false, email: true } };
    const inAppOnly = { delivery: { inApp: true, email: false } };

    assert.equal(shouldAdvanceDigestCheckpoint(emailOnly, {
        hasMatches: true,
        inAppDelivered: false,
        emailDelivered: false
    }), false);
    assert.equal(shouldAdvanceDigestCheckpoint(emailOnly, {
        hasMatches: true,
        inAppDelivered: false,
        emailDelivered: true
    }), true);
    assert.equal(shouldAdvanceDigestCheckpoint(inAppOnly, {
        hasMatches: true,
        inAppDelivered: true,
        emailDelivered: false
    }), true);
    assert.equal(shouldAdvanceDigestCheckpoint(emailOnly, {
        hasMatches: false,
        inAppDelivered: false,
        emailDelivered: false
    }), true);
});
