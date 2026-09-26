const mongoose = require('mongoose');

// One conversation per application, so every thread carries its context:
// which candidate, which internship, and which hiring company.
const conversationSchema = new mongoose.Schema({
    application: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Application',
        required: true,
        unique: true
    },
    internship: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Internship',
        required: true
    },
    candidate: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    // The company account that owns the internship. Every member of that
    // company (owner, recruiters, hiring managers) shares the thread.
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    lastMessageAt: { type: Date, index: true },
    lastMessagePreview: { type: String, default: '' },
    lastMessageBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // When each participant last read the thread. Kept per user so two
    // recruiters at the same company each get their own unread count.
    reads: [{
        _id: false,
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        at: { type: Date, required: true }
    }]
}, { timestamps: true });

module.exports = mongoose.model('Conversation', conversationSchema);
