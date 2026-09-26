/**
 * In-app messaging between recruiters and candidates (GitHub Issue #136).
 *
 * The first half of this file is plain functions (access rules, validation,
 * rate limiting, unread maths) that are tested without a database. The second
 * half does the reads and writes.
 */
const nodemailer = require('nodemailer');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Application = require('../models/Application');
const { COMPANY_ROLES, hasCompanyPermission } = require('../middleware/companyAccess');

const MAX_MESSAGE_LENGTH = Message.MAX_LENGTH;
const PREVIEW_LENGTH = 140;

// A thread stays readable after these, but nobody can post to it.
const READ_ONLY_STATUSES = ['withdrawn', 'rejected'];

// Per user: at most this many messages in the window.
const SEND_LIMIT = { limit: 10, windowMs: 60 * 1000 };
// At most one email per recipient per thread in this window.
const EMAIL_COOLDOWN_MS = 15 * 60 * 1000;

// The notification centre keeps its type list in models/Notification.js.
// Registering the messaging type here keeps the feature in one place.
const typePath = Notification.schema.path('type');
if (typePath && Array.isArray(typePath.enumValues) && !typePath.enumValues.includes('new_message')) {
    typePath.enum('new_message');
}

const idOf = value => String((value && value._id) || value || '');

/**
 * @param {string} status Application status.
 * @returns {boolean} True when the thread should no longer accept messages.
 */
function isReadOnlyStatus(status) {
    return READ_ONLY_STATUSES.includes(String(status || '').toLowerCase());
}

/**
 * The company a user acts for. Older owner accounts predate `companyId`, and
 * for them the owner account is the company, same as middleware/companyAccess.
 *
 * @param {object} user
 * @returns {string|null}
 */
function resolveCompanyId(user) {
    if (!user) return null;
    if (user.companyId) return idOf(user.companyId);
    return user.role === 'company' ? idOf(user._id) : null;
}

/**
 * Whether a company team member may message about applications at all.
 * @param {object} user
 * @returns {boolean}
 */
function isCompanyMessenger(user) {
    return Boolean(user && COMPANY_ROLES.includes(user.role) &&
        hasCompanyPermission(user, 'applications:view') && resolveCompanyId(user));
}

/**
 * Which side of a conversation a user is on, or null if they are not part of
 * it. Every read and write goes through this, so a thread id on its own is
 * never enough to open a conversation.
 *
 * @param {object} user
 * @param {{candidate: *, company: *}} conversation
 * @returns {'candidate'|'company'|null}
 */
function sideFor(user, conversation) {
    if (!user || !conversation) return null;
    if (user.role === 'candidate') {
        return idOf(conversation.candidate) === idOf(user._id) ? 'candidate' : null;
    }
    if (isCompanyMessenger(user) && resolveCompanyId(user) === idOf(conversation.company)) {
        return 'company';
    }
    return null;
}

/**
 * The company that owns an internship. Older listings were owned through
 * postedBy before companyId existed.
 *
 * @param {object} internship
 * @returns {string|null}
 */
function internshipCompanyId(internship) {
    if (!internship) return null;
    if (internship.companyId) return idOf(internship.companyId);
    return internship.postedBy ? idOf(internship.postedBy) : null;
}

/**
 * Which side a user would be on when starting a thread for an application.
 *
 * @param {object} user
 * @param {{candidate: *}} application
 * @param {object} internship
 * @returns {'candidate'|'company'|null}
 */
function sideForApplication(user, application, internship) {
    if (!user || !application || !internship) return null;
    if (user.role === 'candidate') {
        return idOf(application.candidate) === idOf(user._id) ? 'candidate' : null;
    }
    const owner = internshipCompanyId(internship);
    return isCompanyMessenger(user) && owner && owner === resolveCompanyId(user) ? 'company' : null;
}

/**
 * Cleans a message before it is stored. HTML is not stripped: views escape
 * on output, so what the person typed is shown as text.
 *
 * @param {*} raw
 * @returns {{body: string}|{error: string}}
 */
function validateMessageBody(raw) {
    const body = typeof raw === 'string' ? raw.replace(/\r\n/g, '\n').trim() : '';
    if (!body) return { error: 'Write a message before sending.' };
    if (body.length > MAX_MESSAGE_LENGTH) {
        return { error: `Messages can be up to ${MAX_MESSAGE_LENGTH} characters.` };
    }
    return { body };
}

/**
 * @param {string} body
 * @returns {string} One line, trimmed to PREVIEW_LENGTH.
 */
function previewOf(body) {
    const flat = String(body || '').replace(/\s+/g, ' ').trim();
    return flat.length > PREVIEW_LENGTH ? flat.slice(0, PREVIEW_LENGTH - 1) + '…' : flat;
}

/**
 * A sliding window limiter kept in memory. Fine for a single app instance;
 * a shared store would be needed to limit across several.
 *
 * @param {{limit: number, windowMs: number, now?: function(): number}} options
 * @returns {{hit: function(string): {allowed: boolean, retryAfterMs: number}}}
 */
function createRateLimiter({ limit, windowMs, now = Date.now }) {
    const hits = new Map();
    return {
        hit(key) {
            const time = now();
            const recent = (hits.get(key) || []).filter(t => time - t < windowMs);
            if (recent.length >= limit) {
                hits.set(key, recent);
                return { allowed: false, retryAfterMs: windowMs - (time - recent[0]) };
            }
            recent.push(time);
            hits.set(key, recent);
            // Keep the map from growing without bound on a long-lived process.
            if (hits.size > 5000) {
                for (const [k, list] of hits) if (!list.some(t => time - t < windowMs)) hits.delete(k);
            }
            return { allowed: true, retryAfterMs: 0 };
        }
    };
}

/**
 * @param {{reads?: Array<{user: *, at: Date}>}} conversation
 * @param {*} userId
 * @returns {Date|null}
 */
function lastReadAt(conversation, userId) {
    const entry = (conversation.reads || []).find(r => idOf(r.user) === idOf(userId));
    return entry ? new Date(entry.at) : null;
}

/**
 * Whether the conversation has a message the user has not seen. Their own
 * messages never count as unread.
 *
 * @param {object} conversation
 * @param {*} userId
 * @returns {boolean}
 */
function hasUnread(conversation, userId) {
    if (!conversation.lastMessageAt) return false;
    if (idOf(conversation.lastMessageBy) === idOf(userId)) return false;
    const read = lastReadAt(conversation, userId);
    return !read || new Date(conversation.lastMessageAt) > read;
}

const sendLimiter = createRateLimiter(SEND_LIMIT);
const emailSentAt = new Map();

/**
 * Filter for the conversations a user can see in their inbox.
 * @param {object} user
 * @returns {object|null} null when the user has no inbox.
 */
function inboxQuery(user) {
    if (!user) return null;
    if (user.role === 'candidate') return { candidate: user._id };
    if (isCompanyMessenger(user)) return { company: resolveCompanyId(user) };
    return null;
}

/**
 * Unread message counts per conversation for one user, in one query.
 *
 * @param {Array<object>} conversations Must include reads, lastMessageAt, lastMessageBy.
 * @param {*} userId
 * @returns {Promise<Map<string, number>>}
 */
async function unreadCounts(conversations, userId) {
    const withUnread = conversations.filter(c => hasUnread(c, userId)).slice(0, 100);
    if (!withUnread.length) return new Map();

    const rows = await Message.aggregate([
        {
            $match: {
                $or: withUnread.map(c => {
                    const read = lastReadAt(c, userId);
                    return {
                        conversation: c._id,
                        sender: { $ne: userId },
                        ...(read ? { createdAt: { $gt: read } } : {})
                    };
                })
            }
        },
        { $group: { _id: '$conversation', count: { $sum: 1 } } }
    ]);
    return new Map(rows.map(row => [idOf(row._id), row.count]));
}

/**
 * Total unread messages across a user's conversations, for the header badge.
 *
 * @param {object} user
 * @returns {Promise<number>}
 */
async function countUnreadMessages(user) {
    const query = inboxQuery(user);
    if (!query) return 0;
    const conversations = await Conversation.find({ ...query, lastMessageAt: { $ne: null }, lastMessageBy: { $ne: user._id } })
        .select('reads lastMessageAt lastMessageBy')
        .lean();
    const counts = await unreadCounts(conversations, user._id);
    let total = 0;
    counts.forEach(n => { total += n; });
    return total;
}

/**
 * The inbox: newest activity first, with the other party, the internship,
 * the application status and an unread count.
 *
 * @param {object} user
 * @returns {Promise<Array<object>>}
 */
async function getInbox(user) {
    const query = inboxQuery(user);
    if (!query) return [];
    const conversations = await Conversation.find(query)
        .sort({ lastMessageAt: -1, updatedAt: -1 })
        .limit(200)
        .populate('internship', 'title companyName')
        .populate('candidate', 'name avatar')
        .populate('company', 'name companyDetails.companyName')
        .populate('application', 'status')
        .lean();

    const counts = await unreadCounts(conversations, user._id);
    return conversations.map(c => ({ ...c, unread: counts.get(idOf(c._id)) || 0 }));
}

/**
 * Applications a candidate can still start a thread on: open, with a listing,
 * and no conversation yet.
 *
 * @param {Array<object>} applications
 * @param {Array<object>} conversations The candidate's inbox.
 * @returns {Array<object>}
 */
function startableApplications(applications, conversations) {
    const started = new Set((conversations || []).map(c => idOf(c.application)));
    return (applications || []).filter(a =>
        a && a.internship && !isReadOnlyStatus(a.status) && !started.has(idOf(a._id)));
}

/**
 * Lets candidates open a thread from their inbox, so they aren't limited to
 * replying when a recruiter writes first.
 *
 * @param {object} user
 * @param {Array<object>} conversations From getInbox.
 * @returns {Promise<Array<object>>}
 */
async function getStartableApplications(user, conversations) {
    if (!user || user.role !== 'candidate') return [];
    const applications = await Application.find({ candidate: user._id })
        .sort({ appliedAt: -1 })
        .limit(50)
        .populate('internship', 'title companyName')
        .select('status internship appliedAt')
        .lean();
    return startableApplications(applications, conversations);
}

/**
 * Finds the thread for an application, creating it the first time. The
 * unique index on `application` settles two people starting it at once.
 *
 * @param {object} application Must have _id and candidate.
 * @param {object} internship
 * @param {object} user The person starting it.
 * @returns {Promise<object>}
 */
async function getOrCreateConversation(application, internship, user) {
    const existing = await Conversation.findOne({ application: application._id });
    if (existing) return existing;
    try {
        return await Conversation.create({
            application: application._id,
            internship: internship._id,
            candidate: idOf(application.candidate),
            company: internshipCompanyId(internship),
            startedBy: user._id
        });
    } catch (err) {
        if (err && err.code === 11000) return Conversation.findOne({ application: application._id });
        throw err;
    }
}

/**
 * Records that a user has read a thread up to now.
 * @param {*} conversationId
 * @param {*} userId
 * @returns {Promise<void>}
 */
async function markRead(conversationId, userId) {
    const now = new Date();
    const updated = await Conversation.updateOne(
        { _id: conversationId, 'reads.user': userId },
        { $set: { 'reads.$.at': now } },
        { timestamps: false }
    );
    if (!updated.matchedCount) {
        await Conversation.updateOne(
            { _id: conversationId, 'reads.user': { $ne: userId } },
            { $push: { reads: { user: userId, at: now } } },
            { timestamps: false }
        );
    }
}

let transporter = null;
function mailer() {
    if (transporter) return transporter;
    const auth = {
        user: process.env.SMTP_USER || process.env.EMAIL_USER,
        pass: process.env.SMTP_PASS || process.env.EMAIL_PASS
    };
    if (!auth.user || !auth.pass) return null;
    // Same settings as utils/sendEmail.js so one set of env vars covers both.
    transporter = process.env.SMTP_HOST
        ? nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT, 10) || 587,
            secure: process.env.SMTP_SECURE === 'true' || process.env.SMTP_PORT === '465',
            auth
        })
        : nodemailer.createTransport({ service: process.env.EMAIL_SERVICE || 'gmail', auth });
    return transporter;
}

/**
 * Emails the other side, at most once per thread per EMAIL_COOLDOWN_MS so a
 * busy conversation does not flood anyone. Never throws.
 */
async function emailRecipient(conversationId, recipient, fromName, internshipTitle, preview) {
    try {
        if (!recipient || !recipient.email) return;
        const key = `${conversationId}:${idOf(recipient._id)}`;
        const last = emailSentAt.get(key) || 0;
        if (Date.now() - last < EMAIL_COOLDOWN_MS) return;
        const transport = mailer();
        if (!transport) return;
        emailSentAt.set(key, Date.now());

        const base = process.env.APP_URL || `http://localhost:${process.env.PORT || 8080}`;
        await transport.sendMail({
            from: `"InternPilot" <${process.env.SMTP_USER || process.env.EMAIL_USER}>`,
            to: recipient.email,
            subject: `New message from ${fromName} about ${internshipTitle}`,
            text: `${fromName} sent you a message about "${internshipTitle}":\n\n${preview}\n\nReply on InternPilot: ${base}/messages/${conversationId}`
        });
    } catch (err) {
        console.error('Could not send message email:', err.message);
    }
}

/**
 * Stores a message, moves the thread to the top of both inboxes, counts it
 * as read for the sender, and notifies the other side in the app and by email.
 *
 * @param {object} conversation Populated with internship, candidate and company.
 * @param {object} sender
 * @param {'candidate'|'company'} side
 * @param {string} body Already validated.
 * @returns {Promise<object>} The saved message.
 */
async function postMessage(conversation, sender, side, body) {
    const message = await Message.create({ conversation: conversation._id, sender: sender._id, senderSide: side, body });
    const preview = previewOf(body);

    await Conversation.updateOne(
        { _id: conversation._id },
        { $set: { lastMessageAt: message.createdAt, lastMessagePreview: preview, lastMessageBy: sender._id } }
    );
    await markRead(conversation._id, sender._id);

    const internshipTitle = (conversation.internship && conversation.internship.title) || 'an internship';
    const link = `/messages/${conversation._id}`;

    try {
        if (side === 'company') {
            const companyName = conversation.company?.companyDetails?.companyName || conversation.company?.name || 'A recruiter';
            await Notification.create({
                recipient: idOf(conversation.candidate),
                type: 'new_message',
                title: `New message from ${companyName}`,
                message: preview,
                link
            });
            const candidate = await User.findById(idOf(conversation.candidate)).select('email name').lean();
            emailRecipient(idOf(conversation._id), candidate, companyName, internshipTitle, preview);
        } else {
            const candidateName = conversation.candidate?.name || sender.name || 'A candidate';
            await Notification.create({
                companyId: idOf(conversation.company),
                type: 'new_message',
                title: `New message from ${candidateName}`,
                message: preview,
                link
            });
            const company = await User.findById(idOf(conversation.company)).select('email name').lean();
            emailRecipient(idOf(conversation._id), company, candidateName, internshipTitle, preview);
        }
    } catch (err) {
        // A failed notification must never lose the message itself.
        console.error('Could not create message notification:', err.message);
    }

    return message;
}

module.exports = {
    MAX_MESSAGE_LENGTH,
    READ_ONLY_STATUSES,
    SEND_LIMIT,
    EMAIL_COOLDOWN_MS,
    isReadOnlyStatus,
    resolveCompanyId,
    isCompanyMessenger,
    sideFor,
    sideForApplication,
    internshipCompanyId,
    validateMessageBody,
    previewOf,
    createRateLimiter,
    lastReadAt,
    hasUnread,
    sendLimiter,
    inboxQuery,
    unreadCounts,
    countUnreadMessages,
    getInbox,
    startableApplications,
    getStartableApplications,
    getOrCreateConversation,
    markRead,
    postMessage
};
