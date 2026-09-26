const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Internship = require('../models/Internship');
const SavedSearchAlertDelivery = require('../models/SavedSearchAlertDelivery');

test('saved-search e-mail delivery claims are unique per candidate and listing', async () => {
    const delivery = new SavedSearchAlertDelivery({
        candidate: new mongoose.Types.ObjectId(),
        internship: new mongoose.Types.ObjectId(),
        channel: 'instant_email',
        claimToken: 'claim-token'
    });

    await assert.doesNotReject(delivery.validate());
    const indexes = SavedSearchAlertDelivery.schema.indexes();
    assert.ok(indexes.some(([keys, options]) => (
        keys.candidate === 1
        && keys.internship === 1
        && keys.channel === 1
        && options.unique === true
    )));
});

test('publishing or resuming a listing records a publication timestamp', async () => {
    const draft = new Internship({
        companyName: 'Acme Labs',
        title: 'Platform Intern',
        status: 'draft'
    });
    draft.$isNew = false;
    draft.$__.activePaths.clear('modify');
    draft.status = 'published';

    await Internship.schema.s.hooks.execPre('save', draft, [{}]);

    assert.ok(draft.publishedAt instanceof Date);
});
