const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const mongoose = require('mongoose');

const Application = require('../models/Application');
const {
    ApplicationKitValidationError,
    parseApplicationQuestions,
    getResumeVersions,
    buildApplicationKit
} = require('../utils/applicationKit');

const id = () => new mongoose.Types.ObjectId();

function fixture() {
    const projectId = id();
    const certificationId = id();
    const resumeId = id();
    const questionId = id();
    return {
        candidate: {
            _id: id(),
            name: 'Asha Candidate',
            email: 'asha@example.test',
            location: { district: 'Pune', state: 'Maharashtra' },
            education: { qualification: 'B.Tech', institutionName: 'Example Institute' },
            resume: '/uploads/resumes/current.pdf',
            resumeVersions: [{
                _id: resumeId,
                label: 'Backend resume',
                fileUrl: '/uploads/resumes/backend.pdf',
                fileName: 'asha-backend.pdf',
                isDefault: true
            }],
            skills: ['JavaScript'],
            skillProfiles: [
                { name: 'JavaScript', proficiency: 'Advanced' },
                { name: 'MongoDB', proficiency: 'Intermediate' }
            ],
            projects: [{
                _id: projectId,
                title: 'InternPilot API',
                description: 'Built a secure API.',
                link: 'https://portfolio.example.test/api',
                techStack: ['Node.js', 'MongoDB']
            }],
            certifications: [{
                _id: certificationId,
                name: 'Node.js Certificate',
                issuer: 'Example Academy',
                link: 'https://cert.example.test/node'
            }]
        },
        internship: {
            _id: id(),
            title: 'Backend Intern',
            applicationQuestions: [{
                _id: questionId,
                prompt: 'Why are you interested in this role?',
                required: true,
                maxLength: 500
            }]
        },
        ids: { projectId, certificationId, resumeId, questionId }
    };
}

test('listing question parsing treats only explicit true values as required', () => {
    const questions = parseApplicationQuestions({
        applicationQuestions: JSON.stringify([
            { prompt: 'Optional question', required: 'false' },
            { prompt: 'Required question', required: 'true' }
        ])
    });

    assert.deepEqual(questions.map(question => question.required), [false, true]);
});

test('resume versions retain known local upload URLs and the current legacy resume', () => {
    const versions = getResumeVersions({
        resume: '/uploads/resumes/current.pdf',
        resumeVersions: [{ _id: id(), label: 'Targeted', fileUrl: '/uploads/resumes/targeted.pdf', isDefault: true }]
    });

    assert.equal(versions.length, 2);
    assert.equal(versions[0].fileUrl, '/uploads/resumes/current.pdf');
    assert.equal(versions[1].fileUrl, '/uploads/resumes/targeted.pdf');
});

test('a tailored kit is server-built from selected profile records', () => {
    const { candidate, internship, ids } = fixture();
    const kit = buildApplicationKit({
        candidate,
        internship,
        body: {
            resumeVersionId: String(ids.resumeId),
            projectIds: [String(ids.projectId)],
            certificationIds: [String(ids.certificationId)],
            skillNames: ['JavaScript'],
            answers: { [String(ids.questionId)]: 'This role matches my API experience.' }
        },
        submittedAt: new Date('2026-09-26T10:00:00.000Z')
    });

    assert.equal(kit.resume.label, 'Backend resume');
    assert.equal(kit.resume.fileUrl, '/uploads/resumes/backend.pdf');
    assert.deepEqual(kit.skills, [{ name: 'JavaScript', proficiency: 'Advanced' }]);
    assert.equal(kit.projects[0].title, 'InternPilot API');
    assert.equal(kit.certifications[0].name, 'Node.js Certificate');
    assert.equal(kit.answers[0].answer, 'This role matches my API experience.');
    assert.equal(kit.candidateProfile.name, 'Asha Candidate');
});

test('required questions and forged selected IDs are rejected', () => {
    const { candidate, internship, ids } = fixture();

    assert.throws(() => buildApplicationKit({
        candidate,
        internship,
        body: { resumeVersionId: String(ids.resumeId) }
    }), ApplicationKitValidationError);

    assert.throws(() => buildApplicationKit({
        candidate,
        internship,
        body: {
            projectIds: [String(id())],
            answers: { [String(ids.questionId)]: 'Answer' }
        }
    }), /selected projects entries/i);
});

test('a saved snapshot does not change when the live profile changes later', () => {
    const { candidate, internship, ids } = fixture();
    const kit = buildApplicationKit({
        candidate,
        internship,
        body: {
            resumeVersionId: String(ids.resumeId),
            projectIds: [String(ids.projectId)],
            skillNames: ['JavaScript'],
            answers: { [String(ids.questionId)]: 'Original answer' }
        }
    });

    candidate.name = 'Changed later';
    candidate.projects[0].title = 'Changed project';
    candidate.skillProfiles[0].proficiency = 'Beginner';

    assert.equal(kit.candidateProfile.name, 'Asha Candidate');
    assert.equal(kit.projects[0].title, 'InternPilot API');
    assert.equal(kit.skills[0].proficiency, 'Advanced');
});

test('one-click applications create a default snapshot for simple listings', () => {
    const { candidate, internship } = fixture();
    internship.applicationQuestions = [];
    const kit = buildApplicationKit({ candidate, internship, useDefaults: true });

    assert.equal(kit.resume.label, 'Backend resume');
    assert.equal(kit.projects.length, 1);
    assert.equal(kit.certifications.length, 1);
    assert.equal(kit.skills.length, 2);
    assert.deepEqual(kit.answers, []);
});

test('query updates cannot modify an immutable submitted kit', async () => {
    const queryContext = Application.updateOne(
        { _id: id() },
        { $set: { 'applicationKit.resume.fileUrl': 'https://malicious.example.test/new.pdf' } }
    );
    await assert.rejects(
        Application.schema.s.hooks.execPre('updateOne', queryContext, [{}]),
        /immutable/
    );
});

test('Application Kit pages and recruiter view compile and expose submitted records', () => {
    const templatePaths = [
        'views/candidate/application-kit.ejs',
        'views/candidate/application-kit-preview.ejs',
        'views/candidate/application-kit-submission.ejs',
        'views/company/candidate-profile-view.ejs'
    ];
    templatePaths.forEach(relativePath => {
        const templatePath = path.join(__dirname, '..', relativePath);
        const template = fs.readFileSync(templatePath, 'utf8').replace("<% layout('layouts/boilerplate') %>", '');
        assert.doesNotThrow(() => ejs.compile(template, { filename: templatePath }), relativePath);
    });

    const tracker = fs.readFileSync(path.join(__dirname, '..', 'views/candidate/candidate-tracker.ejs'), 'utf8');
    const applicants = fs.readFileSync(path.join(__dirname, '..', 'views/company/company-applicants.ejs'), 'utf8');
    assert.match(tracker, /\/candidate\/applications\/.*\/kit/);
    assert.match(applicants, /Submitted Kit/);
});
