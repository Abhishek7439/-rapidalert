'use strict';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

const admin = require('firebase-admin');

admin.initializeApp({
    projectId: 'demo-rapidalert',
});

async function listAllUsers(nextPageToken) {
    try {
        const listUsersResult = await admin.auth().listUsers(1000, nextPageToken);
        listUsersResult.users.forEach((userRecord) => {
            console.log('User:', userRecord.email, 'UID:', userRecord.uid, 'Claims:', JSON.stringify(userRecord.customClaims));
        });
        if (listUsersResult.pageToken) {
            listAllUsers(listUsersResult.pageToken);
        }
    } catch (error) {
        console.log('Error listing users:', error);
    }
}

listAllUsers();
