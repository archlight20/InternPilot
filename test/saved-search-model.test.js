const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const SavedSearch = require('../models/SavedSearch');

const candidate = new mongoose.Types.ObjectId();

function createSearch(overrides = {}) {
    return new SavedSearch({
        candidate,
        name: 'Pune JavaScript internships',
        criteriaHash: 'criteria-hash',
        criteria: {
            search: 'JavaScript',
            sector: 'Information Technology',
            location: 'Pune',
            skills: ['JavaScript'],
            minStipend: 5000,
            maxStipend: 20000,
            duration: ['3to6']
        },
        ...overrides
    });
}

test('SavedSearch validates normalized criteria and applies alert defaults', async () => {
    const savedSearch = createSearch();

    await assert.doesNotReject(savedSearch.validate());
    assert.equal(savedSearch.frequency, 'instant');
    assert.equal(savedSearch.delivery.inApp, true);
    assert.equal(savedSearch.delivery.email, false);
    assert.equal(savedSearch.isPaused, false);
    assert.ok(savedSearch.alertStartAt instanceof Date);
});

test('SavedSearch accepts only supported alert frequencies and duration buckets', async () => {
    await assert.rejects(
        createSearch({ frequency: 'hourly' }).validate(),
        /frequency/
    );

    await assert.rejects(
        createSearch({ criteria: { duration: ['forever'] } }).validate(),
        /duration/
    );
});

test('SavedSearch exposes candidate-scoped lookup and deduplication indexes', () => {
    const indexes = SavedSearch.schema.indexes();

    assert.ok(indexes.some(([keys, options]) => (
        keys.candidate === 1 && keys.criteriaHash === 1 && options.unique === true
    )));
    assert.ok(indexes.some(([keys]) => (
        keys.candidate === 1 && keys.isPaused === 1 && keys.frequency === 1
    )));
});
