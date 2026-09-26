const mongoose = require('mongoose');

// A durable delivery claim prevents a paused-and-resumed listing from sending
// the same instant e-mail repeatedly to the same candidate. It is deliberately
// separate from Notification: candidates may opt for e-mail only, and an SMTP
// attempt must not create an in-app notification as a side effect.
const savedSearchAlertDeliverySchema = new mongoose.Schema({
    candidate: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    internship: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Internship',
        required: true,
        index: true
    },
    channel: {
        type: String,
        enum: ['instant_email'],
        required: true
    },
    status: {
        type: String,
        enum: ['sending', 'sent'],
        default: 'sending',
        required: true
    },
    // The token makes a stale worker unable to mark or release a newer retry.
    claimToken: { type: String, required: true },
    leaseExpiresAt: { type: Date },
    sentAt: { type: Date }
}, { timestamps: true });

savedSearchAlertDeliverySchema.index(
    { candidate: 1, internship: 1, channel: 1 },
    { unique: true }
);
savedSearchAlertDeliverySchema.index({ status: 1, leaseExpiresAt: 1 });

module.exports = mongoose.model('SavedSearchAlertDelivery', savedSearchAlertDeliverySchema);
