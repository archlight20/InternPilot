const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeSavedSearchCriteria,
    hasSavedSearchCriteria,
    getSavedSearchCriteriaHash,
    buildSavedSearchResultsUrl,
    matchesInternshipCriteria
} = require('../utils/queryHelper');

const matchingInternship = {
    status: 'published',
    isPaused: false,
    title: 'JavaScript Platform Intern',
    companyName: 'Acme Labs',
    sector: 'Information Technology',
    location: { district: 'Pune', state: 'Maharashtra' },
    requiredSkills: ['JavaScript', 'MongoDB'],
    monthlyStipend: 12000,
    duration: '6 Months',
    applicationDeadline: new Date('2030-01-01T00:00:00.000Z')
};

test('normalizes only durable saved-search criteria and discards unsafe query values', () => {
    const criteria = normalizeSavedSearchCriteria({
        search: [' JavaScript ', 'ignored'],
        sector: ' Information Technology ',
        location: { district: 'not a string' },
        skills: 'JavaScript, mongodb, javascript',
        minStipend: '20,000',
        maxStipend: '5,000',
        duration: ['3to6', 'invalid'],
        status: 'paused',
        sort: 'stipend_high',
        page: 9
    });

    assert.deepEqual(criteria, {
        search: 'JavaScript',
        sector: 'Information Technology',
        location: '',
        skills: ['JavaScript', 'mongodb'],
        minStipend: '5000',
        maxStipend: '20000',
        duration: ['3to6']
    });
    assert.equal(hasSavedSearchCriteria(criteria), true);
    assert.equal(hasSavedSearchCriteria({}), false);
});

test('produces stable result URLs and candidate-scoped duplicate hashes', () => {
    const criteria = {
        search: 'JavaScript',
        sector: 'Information Technology',
        skills: ['JavaScript'],
        minStipend: '5000',
        duration: ['3to6']
    };
    const url = buildSavedSearchResultsUrl(criteria);

    assert.match(url, /^\/internships\?/);
    assert.match(url, /status=active/);
    assert.match(url, /search=JavaScript/);
    assert.match(url, /skills=JavaScript/);
    assert.equal(getSavedSearchCriteriaHash(criteria).length, 64);
    assert.equal(getSavedSearchCriteriaHash(criteria), getSavedSearchCriteriaHash({ ...criteria, status: 'paused' }));
});

test('uses the public filter semantics for alert and preview matching', () => {
    const criteria = {
        search: 'platform',
        sector: 'Information Technology',
        location: 'Pune',
        skills: ['MongoDB'],
        minStipend: 10000,
        maxStipend: 15000,
        duration: ['3to6']
    };

    assert.equal(matchesInternshipCriteria(matchingInternship, criteria, new Date('2029-01-01')), true);
    assert.equal(matchesInternshipCriteria({ ...matchingInternship, isPaused: true }, criteria, new Date('2029-01-01')), false);
    assert.equal(matchesInternshipCriteria({ ...matchingInternship, monthlyStipend: 9000 }, criteria, new Date('2029-01-01')), false);
    assert.equal(matchesInternshipCriteria({ ...matchingInternship, requiredSkills: ['Python'] }, criteria, new Date('2029-01-01')), false);
    assert.equal(matchesInternshipCriteria({ ...matchingInternship, applicationDeadline: new Date('2028-01-01') }, criteria, new Date('2029-01-01')), false);
});
