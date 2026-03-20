import admin from "firebase-admin";

let initialized = false;

const initFirebaseAdmin = () => {
  if (initialized || admin.apps.length) {
    initialized = true;
    return;
  }

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();

  if (serviceAccountJson) {
    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(serviceAccountJson) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }

    admin.initializeApp({
      credential: admin.credential.cert(parsed as admin.ServiceAccount),
    });
    initialized = true;
    return;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
    initialized = true;
    return;
  }

  throw new Error(
    "Missing Firebase credentials. Provide FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS."
  );
};

export const verifyFirebaseIdToken = async (token: string) => {
  initFirebaseAdmin();
  return admin.auth().verifyIdToken(token);
};
