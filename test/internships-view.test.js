const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ejs = require('ejs');

const internshipsViewPath = path.join(__dirname, '..', 'views', 'extras', 'internships.ejs');
const internshipsTemplate = fs.readFileSync(internshipsViewPath, 'utf8');

test('internships view compiles and renders an empty listing state', () => {
    assert.doesNotThrow(() => {
        ejs.compile(internshipsTemplate, { filename: internshipsViewPath });
    });

    const html = ejs.render(internshipsTemplate, {
        layout: () => undefined,
        currentUser: null,
        internships: [],
        queryState: {},
        currentFilter: 'all',
        pagination: null,
        sectors: [],
        appliedIds: []
    }, { filename: internshipsViewPath });

    assert.match(html, /No matching internships found/);
});

test('internships view gives candidates a save-search control for active filters', () => {
    const html = ejs.render(internshipsTemplate, {
        layout: () => undefined,
        currentUser: { _id: 'candidate-1', role: 'candidate' },
        internships: [],
        queryState: { search: 'JavaScript', skills: ['JavaScript'], status: 'all', sort: 'latest' },
        currentFilter: 'all',
        pagination: null,
        sectors: [],
        appliedIds: []
    }, { filename: internshipsViewPath });

    assert.match(html, /Save this search/);
    assert.match(html, /name="criteria"/);
    assert.match(html, /Instant — when a match is published/);
});
