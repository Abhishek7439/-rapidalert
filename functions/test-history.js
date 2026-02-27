const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT = 'rapidalert';

initializeApp({ projectId: 'rapidalert' });
const db = getFirestore();

async function runTest() {
    console.log('Inserting inactive alert into emulator...');
    const ref = await db.collection('alerts').add({
        active: false,
        cancelledAt: FieldValue.serverTimestamp(),
        type: 'Earthquake',
        severity: 'Warning',
        area: 'Pune',
        message: 'Test resolved alert for history tab',
        timeSent: new Date(Date.now() - 3600000), // 1 hour ago
        reach: 450,
        isDrill: true
    });
    console.log('Inserted inactive alert ID:', ref.id);

    // also add delivery stats so the modal shows them
    await db.collection('notification_logs').doc(ref.id).set({
        alertId: ref.id,
        timestamp: FieldValue.serverTimestamp(),
        topicDelivered: true,
        totalUsersInZone: 450,
        notificationsSent: 440,
        failedCount: 10,
        dispatchPath: 'admin_panel -> district_pune'
    });
    console.log('Added log stats');
    process.exit(0);
}
runTest().catch(console.error);
