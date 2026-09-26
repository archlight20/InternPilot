const test = require('node:test');
const assert = require('node:assert/strict');

const {
    parseApplicationSearch,
    filterAndSortApplications
} = require('../utils/applicationSearch');

const applications = [
    {
        _id: '1',
        status: 'Submitted',
        appliedAt: new Date('2026-09-20T10:00:00.000Z'),
        statusUpdatedAt: new Date('2026-09-22T10:00:00.000Z'),
        internship: { title: 'Backend Intern', companyName: 'Acme Labs' }
    },
    {
        _id: '2',
        status: 'Under Review',
        appliedAt: new Date('2026-09-21T10:00:00.000Z'),
        statusUpdatedAt: new Date('2026-09-23T10:00:00.000Z'),
        internship: { title: 'Design Intern', companyName: 'Bright Studio' }
    },
    {
        _id: '3',
        status: 'pending',
        appliedAt: new Date('2026-09-19T10:00:00.000Z'),
        statusUpdatedAt: new Date('2026-09-19T10:00:00.000Z'),
        internship: { title: 'Frontend Intern', companyName: 'Acme Labs' }
    }
];

test('application search accepts only supported query controls', () => {
    assert.deepEqual(parseApplicationSearch({
        search: ['  Acme  ', 'ignored'],
        status: 'not-a-status',
        sort: 'not-a-sort'
    }), {
        search: 'Acme',
        status: 'all',
        sort: 'recent'
    });
});

test('filters by internship title or company name case-insensitively', () => {
    const byTitle = filterAndSortApplications(applications, { search: 'design' });
    assert.deepEqual(byTitle.applications.map(application => application._id), ['2']);

    const byCompany = filterAndSortApplications(applications, { search: 'ACME' });
    assert.deepEqual(byCompany.applications.map(application => application._id), ['1', '3']);
});

test('combines title/company search, status filters, and selected sort', () => {
    const result = filterAndSortApplications(applications, {
        search: 'acme',
        status: 'Submitted',
        sort: 'oldest'
    });

    assert.equal(result.totalApplications, 3);
    assert.deepEqual(result.applications.map(application => application._id), ['3', '1']);
});
