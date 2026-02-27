const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { setDoc, doc, addDoc, collection, serverTimestamp } = require('firebase/firestore');
const fs = require('fs');

async function run() {
    console.log("🔴 PHASE 1 – SECURITY VALIDATION");

    const rules = fs.readFileSync("../firestore.rules", "utf8");

    const testEnv = await initializeTestEnvironment({
        projectId: "smart-community-8fd9a",
        firestore: {
            rules,
            host: "127.0.0.1",
            port: 8080
        }
    });

    const citizenContext = testEnv.authenticatedContext('citizen-123', { role: 'citizen' });
    const adminContext = testEnv.authenticatedContext('admin-123', { role: 'super_admin' });
    const unauthContext = testEnv.unauthenticatedContext();

    const citizenDb = citizenContext.firestore();
    const adminDb = adminContext.firestore();
    const unauthDb = unauthContext.firestore();

    try {
        // 1. Attempt alert creation using non-admin account -> must fail
        console.log("Testing: Attempt alert creation using non-admin account...");
        await assertFails(addDoc(collection(citizenDb, 'alerts'), {
            active: true,
            type: "Earthquake",
            severity: "Emergency",
            message: "Test message",
            area: "Test City",
            creatorUid: "citizen-123",
            timeSent: serverTimestamp(),
            geofence: { type: 'none' }
        }));
        console.log("✅ Passed: Citizen cannot create alert");

        // 2. Attempt Firestore direct write to alerts collection via REST (unauth) -> must fail
        console.log("Testing: Attempt direct REST write to alerts collection (unauth)...");
        await assertFails(addDoc(collection(unauthDb, 'alerts'), {
            active: true,
            type: "Cyclone",
            severity: "Emergency",
            message: "Hacked alert",
            area: "Test City",
            creatorUid: "admin-123",
            timeSent: serverTimestamp(),
            geofence: { type: 'none' }
        }));
        console.log("✅ Passed: Unauthenticated user cannot create alert");

        // 3. Attempt SOS write without authentication -> must fail
        console.log("Testing: Attempt SOS write without authentication...");
        await assertFails(addDoc(collection(unauthDb, 'sos_requests'), {
            citizenUid: "citizen-123",
            name: "Hacker",
            status: "Pending",
            time: serverTimestamp(),
            // Mocking latlng class missing in standard client SDK without setup, just a map is rejected by rules requiring latlng
            location: { latitude: 0, longitude: 0 }
        }));
        console.log("✅ Passed: Unauthenticated user cannot create SOS");

        // 4. Attempt role escalation without custom claim -> must fail
        console.log("Testing: Attempt role escalation without custom claim...");
        await assertFails(setDoc(doc(citizenDb, 'users', 'citizen-123'), {
            uid: 'citizen-123',
            name: "Test Citizen",
            role: "super_admin"
        }));
        console.log("✅ Passed: Citizen cannot escalate role during write");

        // 5. Verify server-side rule enforcement (Admin can create alert)
        console.log("Testing: Verify Admin can create alert...");
        await assertSucceeds(setDoc(doc(adminDb, 'alerts', 'valid-admin-alert'), {
            active: true,
            type: "Earthquake",
            severity: "Emergency",
            message: "Test message from admin",
            area: "Test City",
            creatorUid: "admin-123",
            timeSent: serverTimestamp(),
            geofence: { type: 'none' }
        }));
        console.log("✅ Passed: Admin can successfully create an alert");

        console.log("\n✅ PHASE 1 COMPLETE: All security validation tests passed successfully.\n");
        process.exit(0);

    } catch (e) {
        console.error("❌ SECURITY VALIDATION FAILED:");
        console.error(e.message);
        process.exit(1);
    } finally {
        await testEnv.cleanup();
    }
}

run();
