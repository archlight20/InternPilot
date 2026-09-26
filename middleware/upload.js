const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');


cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});


const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'internpilot/resumes',
        allowed_formats: ['pdf', 'doc', 'docx'],
        resource_type: 'auto'
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }
});


const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

const DOCUMENT_MIME_TYPES = [
    'application/pdf',
    'application/x-pdf',
    'image/png',
    'image/jpeg',
    'image/jpg'
];

const DOCUMENT_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg'];

const documentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: DOCUMENT_MAX_BYTES },
    fileFilter: (req, file, cb) => {
        const name = (file.originalname || '').toLowerCase();
        const hasAllowedExtension = DOCUMENT_EXTENSIONS.some(ext => name.endsWith(ext));

        if (DOCUMENT_MIME_TYPES.includes(file.mimetype) && hasAllowedExtension) {
            return cb(null, true);
        }
        cb(new Error('Only PDF, PNG or JPG files under 5MB are allowed.'));
    }
});


const LOGO_MAX_BYTES = 3 * 1024 * 1024;

const LOGO_MIME_TYPES = [
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/svg+xml'
];

const LOGO_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.svg'];

const logoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: LOGO_MAX_BYTES },
    fileFilter: (req, file, cb) => {
        const name = (file.originalname || '').toLowerCase();
        const hasAllowedExtension = LOGO_EXTENSIONS.some(ext => name.endsWith(ext));

        if (LOGO_MIME_TYPES.includes(file.mimetype) && hasAllowedExtension) {
            return cb(null, true);
        }
        cb(new Error('Only PNG, JPG, JPEG, WEBP, or SVG images under 3MB are allowed for logo.'));
    }
});

const uploadBufferToCloudinary = (file, folder) => {
    return new Promise((resolve, reject) => {
        const safeName = (file.originalname || 'document').replace(/[^a-zA-Z0-9_.-]/g, '_');
        const isImage = file.mimetype.startsWith('image/');

        const uploadStream = cloudinary.uploader.upload_stream(
            {
                public_id: `${folder}/${Date.now()}_${safeName}`,
                resource_type: isImage ? 'image' : 'raw',
                disable_promises: true
            },
            (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }
        );
        uploadStream.on('error', (error) => reject(error));
        uploadStream.end(file.buffer);
    });
};

module.exports = {
    upload,
    cloudinary,
    documentUpload,
    logoUpload,
    uploadBufferToCloudinary,
    DOCUMENT_MAX_BYTES,
    DOCUMENT_EXTENSIONS,
    LOGO_MAX_BYTES,
    LOGO_EXTENSIONS
};