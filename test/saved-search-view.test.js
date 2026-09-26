const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const viewPath = path.join(__dirname, '..', 'views', 'candidate', 'saved-searches.ejs');
const template = fs.readFileSync(viewPath, 'utf8');

test('saved-searches view renders management controls and matching preview', () => {
    const html = ejs.render(template, {
        layout: () => undefined,
        currentUser: { _id: 'candidate-1', role: 'candidate' },
        maxSavedSearches: 10,
        savedSearches: [{
            _id: 'saved-search-1',
            name: 'Pune JavaScript internships',
            frequency: 'daily',
            delivery: { inApp: true, email: true },
            isPaused: false,
            criteriaLabels: ['Location: Pune', 'Skill: JavaScript'],
            matchingCount: 1,
            matchingPreview: [{
                _id: 'internship-1',
                title: 'Platform Intern',
                companyName: 'Acme Labs',
                location: { district: 'Pune', state: 'Maharashtra' },
                monthlyStipend: 12000
            }]
        }]
    }, { filename: viewPath });

    assert.match(html, /Pune JavaScript internships/);
    assert.match(html, /Platform Intern/);
    assert.match(html, /\?_method=PATCH/);
    assert.match(html, /\/pause/);
    assert.match(html, /\?_method=DELETE/);
});

test('saved-searches view renders an actionable empty state', () => {
    const html = ejs.render(template, {
        layout: () => undefined,
        currentUser: { _id: 'candidate-1', role: 'candidate' },
        maxSavedSearches: 10,
        savedSearches: []
    }, { filename: viewPath });

    assert.match(html, /No saved searches yet/);
    assert.match(html, /Explore and save a search/);
});

test('saved-search edit view exposes every durable filter and alert setting', () => {
    const editPath = path.join(__dirname, '..', 'views', 'candidate', 'saved-search-edit.ejs');
    const editTemplate = fs.readFileSync(editPath, 'utf8');
    const html = ejs.render(editTemplate, {
        layout: () => undefined,
        currentUser: { _id: 'candidate-1', role: 'candidate' },
        savedSearch: {
            _id: 'saved-search-1',
            name: 'Pune JavaScript internships',
            frequency: 'weekly',
            delivery: { inApp: true, email: false },
            criteria: {
                search: 'JavaScript',
                sector: 'Information Technology',
                location: 'Pune',
                skills: ['JavaScript', 'MongoDB'],
                minStipend: 5000,
                maxStipend: 20000,
                duration: ['3to6']
            }
        }
    }, { filename: editPath });

    assert.match(html, /criteria\[search\]/);
    assert.match(html, /criteria\[skills\]/);
    assert.match(html, /criteria\[duration\]/);
    assert.match(html, /Weekly digest/);
    assert.match(html, /Update saved search/);
});
