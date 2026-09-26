const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String },
    googleId: { type: String },
    avatar: { type: String },

    role: {
        type: String,
        enum: ['candidate', 'company', 'recruiter', 'hiring_manager', 'admin'],
        default: 'candidate',
        required: true
    },

    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    isActive: { type: Boolean, default: true },

    age: { type: Number },
    familyIncome: { type: Number },
    institution: { type: String },
    enrollmentStatus: { type: String, trim: true, default: '' },
    employmentStatus: { type: String, trim: true, default: '' },
    // Keep this legacy string list as a compatibility mirror while callers
    // gradually move to `skillProfiles`. Existing users are read as
    // Intermediate through utils/skillProfiles when no structured entry exists.
    skills: [{ type: String, trim: true }],
    skillProfiles: [{
        _id: false,
        name: { type: String, required: true, trim: true, maxlength: 80 },
        proficiency: {
            type: String,
            enum: ['Beginner', 'Intermediate', 'Advanced'],
            default: 'Intermediate',
            required: true
        }
    }],
    resume: { type: String, default: '' },
    resumeOriginalName: { type: String, default: '', trim: true },
    resumeUploadedAt: { type: Date },

    resumeQuality: {
    quantifiableAchievements: {
        status: { type: String, default: '' },
        feedback: { type: String, default: '' }
    },
    technicalSkills: {
        status: { type: String, default: '' },
        feedback: { type: String, default: '' }
    },
    projects: {
        status: { type: String, default: '' },
        feedback: { type: String, default: '' }
    },
    overallFeedback: { type: String, default: '' }
},

    location: {
        district: { type: String, default: '' },
        state: { type: String, default: '' }
    },
    education: {
        qualification: { type: String, default: '' },
        institutionName: { type: String, default: '' }
    },

    certifications: [{
        name: { type: String, required: true, trim: true, maxlength: 120 },
        issuer: { type: String, default: '', trim: true, maxlength: 120 },
        issueDate: { type: Date },
        link: { type: String, default: '', trim: true },
        fileUrl: { type: String, default: '' },
        fileName: { type: String, default: '' },
        createdAt: { type: Date, default: Date.now }
    }],

    projects: [{
        title: { type: String, required: true, trim: true, maxlength: 120 },
        description: { type: String, default: '', trim: true, maxlength: 1000 },
        link: { type: String, default: '', trim: true },
        techStack: [{ type: String, trim: true }],
        fileUrl: { type: String, default: '' },
        fileName: { type: String, default: '' },
        createdAt: { type: Date, default: Date.now }
    }],

    savedInternships: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Internship'
    }],

    companyDetails: {
        companyName: { type: String, trim: true },
        cin: { type: String, trim: true },
        industry: { type: String, trim: true },
        logo: { type: String, default: '' },
        description: { type: String, default: '', trim: true },
        website: { type: String, default: '', trim: true },
        location: { type: String, default: '', trim: true },
        contactEmail: { type: String, default: '', trim: true },
        contactPhone: { type: String, default: '', trim: true },
        contactInformation: { type: String, default: '', trim: true },
        companySize: { type: String, default: '', trim: true },
        isVerified: { type: Boolean, default: false }
    },

    isEmailVerified: { type: Boolean, default: false },

    otp: { type: String },
    otpExpires: { type: Date },
    lastOtpSentAt: { type: Date },

    createdAt: { type: Date, default: Date.now }
}, { toJSON: { virtuals: true }, toObject: { virtuals: true } });

// Virtual to synchronize institution with education.institutionName
userSchema.virtual('institutionName').get(function () {
    return this.education?.institutionName || this.institution || '';
});

// Hash password before saving
userSchema.pre('save', async function () {
    if (!this.isModified('password') || !this.password) return;

    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

// Compare Password Helper Method
userSchema.methods.comparePassword = async function (candidatePassword) {
    if (!this.password) return false;
    return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
