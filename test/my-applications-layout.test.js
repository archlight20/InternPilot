const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { sanitizeHttpUrl } = require('../utils/safeUrl');

const trackerPath = path.join(__dirname, '..', 'views', 'candidate', 'candidate-tracker.ejs');

function renderTracker({ meetingLink = 'https://meet.example.test/room' } = {}) {
    const template = fs.readFileSync(trackerPath, 'utf8')
        .replace("<% layout('layouts/boilerplate') %>", '');
    const internship = {
        _id: '66aa00000000000000000001',
        title: 'Software Development Intern',
        companyName: 'Toyota Motors Ltd',
        sector: 'Technology',
        location: { district: 'Pune', state: 'Maharashtra' },
        monthlyStipend: 12000
    };
    const applications = [
        {
            _id: 'active-card',
            status: 'Under Review',
            matchScore: 82,
            appliedAt: new Date('2026-09-20T12:00:00.000Z'),
            statusUpdatedAt: new Date('2026-09-24T12:00:00.000Z'),
            internship
        },
        {
            _id: 'interview-card',
            status: 'Interview',
            matchScore: 91,
            appliedAt: new Date('2026-09-19T12:00:00.000Z'),
            statusUpdatedAt: new Date('2026-09-25T12:00:00.000Z'),
            internship,
            interview: {
                status: 'Scheduled',
                scheduledAt: new Date('2026-09-28T08:30:00.000Z'),
                duration: 30,
                mode: 'Online',
                meetingLink,
                instructions: 'Join five minutes early.'
            }
        },
        {
            _id: 'withdrawn-card',
            status: 'Withdrawn',
            matchScore: 48,
            appliedAt: new Date('2026-09-18T12:00:00.000Z'),
            internship,
            withdrawalReason: 'Schedule conflict'
        }
    ];

    return ejs.render(template, {
        applications,
        candidate: { name: 'Candidate' },
        sanitizeHttpUrl,
        formatRelativeTime: () => '2 days ago',
        formatLocalizedDateTime: () => '24 Sept 2026, 5:30 pm'
    }, { filename: trackerPath });
}

function occurrences(text, pattern) {
    return (text.match(pattern) || []).length;
}

test('My Applications cards use the same four-column grid for every status', () => {
    const html = renderTracker();

    assert.equal(occurrences(html, /data-application-grid/g), 3);
    assert.equal(occurrences(html, /data-card-column="job-details"/g), 3);
    assert.equal(occurrences(html, /data-card-column="skill-fit"/g), 3);
    assert.equal(occurrences(html, /data-card-column="stage"/g), 3);
    assert.equal(occurrences(html, /data-card-column="actions"/g), 3);
    assert.match(html, /lg:grid-cols-\[minmax\(0,1\.65fr\)_minmax\(140px,0\.65fr\)_minmax\(270px,1\.2fr\)_minmax\(150px,0\.7fr\)\]/);
});

test('active applications use a timeline while withdrawn applications use a non-clickable status', () => {
    const html = renderTracker();

    assert.equal(occurrences(html, /data-stage-tracker/g), 2);
    assert.equal(occurrences(html, /data-terminal-status/g), 1);
    assert.match(html, /Current: Under Review/);
    assert.match(html, /Current: Interview/);
    assert.match(html, /Withdrawn/);
    assert.match(html, /data-action-state="unavailable"/);
    assert.doesNotMatch(html, /ph-arrow-u-up-left/);
});

test('interview details remain nested in the related application card', () => {
    const html = renderTracker();
    const interviewStart = html.indexOf('id="app-card-interview-card"');
    const withdrawnStart = html.indexOf('id="app-card-withdrawn-card"');
    const interviewCard = html.slice(interviewStart, withdrawnStart);

    assert.ok(interviewStart >= 0);
    assert.ok(withdrawnStart > interviewStart);
    assert.match(interviewCard, /data-interview-details/);
    assert.match(interviewCard, /Interview Scheduled/);
    assert.match(interviewCard, /Join meeting/);
    assert.match(interviewCard, /rel="noopener noreferrer"/);
});

test('unsafe legacy meeting links are not rendered as candidate actions', () => {
    const html = renderTracker({ meetingLink: 'javascript:alert("xss")' });

    assert.match(html, /data-interview-details/);
    assert.doesNotMatch(html, /href="javascript:/i);
    assert.doesNotMatch(html, />\s*Join meeting\s*</);
});

test('the legacy My Applications URL renders the canonical tracker template', () => {
    const candidateRoutes = fs.readFileSync(
        path.join(__dirname, '..', 'routes', 'candidate.js'),
        'utf8'
    );

    assert.match(candidateRoutes, /res\.render\('candidate\/candidate-tracker'/);
    assert.match(candidateRoutes, /\.sort\(sortObj\)/);
});

test('invalid legacy date values do not break the application page', () => {
    const template = fs.readFileSync(trackerPath, 'utf8')
        .replace("<% layout('layouts/boilerplate') %>", '');

    assert.doesNotThrow(() => ejs.render(template, {
        applications: [{
            _id: 'invalid-date-card',
            status: 'Submitted',
            appliedAt: 'not-a-date',
            statusUpdatedAt: 'also-not-a-date',
            internship: { title: 'Legacy internship' }
        }],
        formatRelativeTime: () => 'just now',
        formatLocalizedDateTime: () => 'invalid'
    }, { filename: trackerPath }));
});
