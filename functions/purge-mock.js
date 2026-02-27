const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT = 'rapidalert';

initializeApp({ projectId: 'rapidalert' });
const db = getFirestore();

async function purgeMockData() {
    console.log('Purging mock alerts from emulator...');
    const alertsSnapshot = await db.collection('alerts').where('message', '==', 'Test resolved alert for history tab').get();

    const batch = db.batch();
    let count = 0;

    for (const doc of alertsSnapshot.docs) {
        batch.delete(doc.ref);
        batch.delete(db.collection('notification_logs').doc(doc.id));
        console.log('Deleted mock alert and logs for ID:', doc.id);
        count++;
    }

    if (count > 0) {
        await batch.commit();
        console.log(`Successfully purged ${count} mock alerts and their associated logs.`);
    } else {
        console.log('No mock alerts found.');
    }
}

purgeMockData().catch(console.error).finally(() => process.exit(0));
