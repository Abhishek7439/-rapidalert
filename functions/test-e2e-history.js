const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT = 'smart-community-8fd9a';

initializeApp({ projectId: 'smart-community-8fd9a' });
const db = getFirestore();

async function runValidation() {
    console.log('--- Phase 2 Validation ---');

    // 1. Create a live Alert
    console.log('1. Creating a LIVE alert...');
    const alertRef = await db.collection('alerts').add({
        active: true,
        type: 'Cyclone',
        severity: 'Evacuate',
        area: 'Test City Area',
        message: 'This is a real end-to-end validation test.',
        timeSent: FieldValue.serverTimestamp(),
        centerLat: 20.9903,
        centerLng: 79.0240,
        radius: 5000,
        creatorUid: 'admin-123',
        creatorName: 'Test Admin',
        reach: 1
    });
    console.log(`Alert Created! ID: ${alertRef.id}`);

    // Wait for triggers (onDocumentCreated) with polling
    console.log('Checking Notification Logs (polling)...');
    let logDoc;
    let foundLog = false;
    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        logDoc = await db.collection('notification_logs').doc(alertRef.id).get();
        if (logDoc.exists) {
            foundLog = true;
            break;
        }
        process.stdout.write('.');
    }
    console.log('');

    if (foundLog) {
        console.log('✅ Notification Log created:', logDoc.data().dispatchPath);
    } else {
        console.error('❌ Notification Log missing!');
    }

    // Check admin logs for ALERT_CREATED
    console.log('Checking Admin Logs for creation event...');
    let adminLogsSnap = await db.collection('admin_logs')
        .where('action', '==', 'ALERT_CREATED')
        .orderBy('timestamp', 'desc').limit(1).get();

    // Fallback if index isn't ready
    if (adminLogsSnap.empty) {
        console.log('Index might not be ready, fetching top logs...');
        adminLogsSnap = await db.collection('admin_logs').orderBy('timestamp', 'desc').limit(5).get();
        let found = false;
        adminLogsSnap.forEach(r => {
            if (r.data().action === 'ALERT_CREATED' && r.data().details?.alertType === 'Cyclone') found = true;
        });
        if (found) console.log('✅ Admin Log ALERT_CREATED found!');
        else console.log('❌ Admin Log missing or not captured.');
    } else {
        console.log('✅ Admin Log ALERT_CREATED found via query!');
    }

    // 2. Cancel the Alert
    console.log(`\n2. Cancelling the alert (ID: ${alertRef.id})...`);
    await alertRef.update({
        active: false,
        cancelledAt: FieldValue.serverTimestamp(),
        cancelledBy: 'admin-123'
    });
    console.log('Alert status updated to active: false');

    // Poll for the cancel trigger
    console.log('Waiting for cancellation triggers (onDocumentUpdated)...');
    let foundCancel = false;
    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        let cancelLogsSnap = await db.collection('admin_logs')
            .where('action', '==', 'ALERT_CANCELLED')
            .orderBy('timestamp', 'desc')
            .limit(5).get();

        if (cancelLogsSnap.empty) {
            cancelLogsSnap = await db.collection('admin_logs').orderBy('timestamp', 'desc').limit(10).get();
        }

        cancelLogsSnap.forEach(r => {
            if (r.data().action === 'ALERT_CANCELLED' && r.data().details?.alertId === alertRef.id) foundCancel = true;
        });

        if (foundCancel) break;
        process.stdout.write('.');
    }
    console.log('');

    // Verify it is now fetched by History query (active == false)
    console.log('Checking History Query (`where active == false`)....');
    const historySnap = await db.collection('alerts').where('active', '==', false).get();
    let foundInHistory = false;
    historySnap.forEach(doc => {
        if (doc.id === alertRef.id) foundInHistory = true;
    });

    if (foundInHistory) {
        console.log('✅ Alert successfully transitioned to History query results!');
    } else {
        console.error('❌ Alert NOT found in History query!');
    }

    if (foundCancel) console.log('✅ Admin Log ALERT_CANCELLED found!');
    else console.log('❌ Admin Log ALERT_CANCELLED missing (timeout).');

    console.log('\nValidation Complete.');
    process.exit(0);
}

runValidation().catch(err => {
    console.error('Validation Error:', err);
    process.exit(1);
});
