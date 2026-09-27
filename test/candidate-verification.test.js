const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const test = require('node:test');

const CandidateVerification = require('../models/CandidateVerification');
const candidateVerificationRouter = require('../routes/candidateVerification');
const adminRouter = require('../routes/admin');
const internshipRouter = require('../routes/internships');
const {
    CandidateVerificationError,
    maskIdentifier,
    applyCandidateVerificationDecision,
    submitCandidateVerification,
    assertCandidateVerified
} = require('../utils/candidateVerification');
const { acceptOffer } = require('../utils/offers');

const id = () => new mongoose.Types.ObjectId();

function hasRoute(router, method, path) {
    return router.stack.some(layer => layer.route && layer.route.path === path && layer.route.methods[method]);
}

function documentReference() {
    return {
        documentType: 'identity',
        fileName: 'identity-proof.pdf',
        storageKey: 'internpilot/candidate_verification/identity-proof',
        fileUrl: 'https://storage.example.test/identity-proof.pdf'
    };
}

test('candidate verification retains only document pointers and a masked identifier', async () => {
    const rawIdentifier = '1234-5678-9012';
    const verification = new CandidateVerification({
        candidate: id(),
        status: 'pending',
        documents: [documentReference()],
        maskedIdentifier: maskIdentifier(rawIdentifier)
    });

    await assert.doesNotReject(verification.validate());
    assert.equal(verification.maskedIdentifier, '•••• 9012');
    assert.equal(verification.maskedIdentifier.includes(rawIdentifier), false);
    assert.equal(CandidateVerification.schema.path('identityNumber'), undefined);
    assert.equal(CandidateVerification.schema.path('documents').schema.path('storageKey') !== undefined, true);

    const unsafe = new CandidateVerification({
        candidate: id(), documents: [documentReference()], maskedIdentifier: rawIdentifier
    });
    assert.ok(unsafe.validateSync()?.errors.maskedIdentifier);
});

test('review decisions require a reason, enforce valid transitions, and record an audit event', () => {
    const verification = { status: 'pending', history: [] };
    assert.throws(
        () => applyCandidateVerificationDecision(verification, 'approved', { reviewerId: 'admin-id', reason: '' }),
        error => error instanceof CandidateVerificationError && error.code === 'VERIFICATION_REASON_REQUIRED'
    );

    const reviewedAt = new Date('2026-09-27T10:00:00.000Z');
    applyCandidateVerificationDecision(verification, 'approved', {
        reviewerId: 'admin-id', reason: 'Identity and eligibility evidence match the submitted profile.', at: reviewedAt
    });
    assert.equal(verification.status, 'approved');
    assert.deepEqual(verification.history[0], {
        fromStatus: 'pending',
        toStatus: 'approved',
        reason: 'Identity and eligibility evidence match the submitted profile.',
        changedBy: 'admin-id',
        actorRole: 'admin',
        changedAt: reviewedAt
    });

    assert.throws(
        () => applyCandidateVerificationDecision(verification, 'rejected', { reviewerId: 'admin-id', reason: 'Changed my mind.' }),
        error => error instanceof CandidateVerificationError && error.code === 'INVALID_VERIFICATION_TRANSITION'
    );
});

test('candidate document resubmission returns verification to pending and keeps its history', () => {
    const verification = { candidate: 'candidate-id', status: 'rejected', history: [], isNew: false };
    submitCandidateVerification(verification, {
        candidateId: 'candidate-id',
        documents: [documentReference()],
        maskedIdentifier: '•••• 1234',
        at: new Date('2026-09-27T10:00:00.000Z')
    });

    assert.equal(verification.status, 'pending');
    assert.equal(verification.history.at(-1).fromStatus, 'rejected');
    assert.equal(verification.history.at(-1).toStatus, 'pending');
    assert.equal(verification.history.at(-1).actorRole, 'candidate');
});

test('application and offer gates accept only approved candidate verification', async () => {
    const ApprovedModel = { async findOne() { return { status: 'approved' }; } };
    const PendingModel = { async findOne() { return { status: 'pending' }; } };

    await assert.doesNotReject(() => assertCandidateVerified('candidate-id', ApprovedModel));
    await assert.rejects(
        () => assertCandidateVerified('candidate-id', PendingModel),
        error => error instanceof CandidateVerificationError
            && error.code === 'CANDIDATE_VERIFICATION_REQUIRED'
            && error.statusCode === 403
    );

    let offerMutationAttempted = false;
    await assert.rejects(
        () => acceptOffer({
            offerId: 'offer-id',
            candidateId: 'candidate-id',
            CandidateVerificationModel: PendingModel,
            OfferModel: {
                async findOneAndUpdate() {
                    offerMutationAttempted = true;
                    return null;
                }
            }
        }),
        error => error instanceof CandidateVerificationError && error.code === 'CANDIDATE_VERIFICATION_REQUIRED'
    );
    assert.equal(offerMutationAttempted, false, 'unverified candidates must not reserve or mutate an offer');
});

test('candidate verification routes and both application entry points are registered', () => {
    assert.equal(hasRoute(candidateVerificationRouter, 'get', '/candidate/verification'), true);
    assert.equal(hasRoute(candidateVerificationRouter, 'post', '/candidate/verification/documents'), true);
    assert.equal(hasRoute(adminRouter, 'get', '/candidate-verifications'), true);
    assert.equal(hasRoute(adminRouter, 'post', '/candidate-verifications/:id/approve'), true);
    assert.equal(hasRoute(adminRouter, 'post', '/candidate-verifications/:id/reject'), true);
    assert.equal(hasRoute(adminRouter, 'post', '/candidate-verifications/:id/suspend'), true);
    assert.equal(hasRoute(internshipRouter, 'post', '/:id/apply'), true);
    assert.equal(hasRoute(internshipRouter, 'post', '/:id/application-kit/submit'), true);
});
