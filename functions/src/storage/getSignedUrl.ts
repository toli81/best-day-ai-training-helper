import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Storage } from '@google-cloud/storage';

const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET || 'bestday-training-videos';

interface RequestData { path: string }
interface ResponseData { url: string }

export const getSignedUrl = functions.https.onCall(
  async (data: RequestData, context): Promise<ResponseData> => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
    }

    const { path } = data;
    const uid = context.auth.uid;

    // Verify ownership: path must start with trainers/{uid}/ OR be a library clip
    const isOwnContent = path.startsWith(`trainers/${uid}/`);
    const isLibraryClip = path.startsWith('library/clips/');

    if (!isOwnContent && !isLibraryClip) {
      // Allow access if this video belongs to a shared library exercise
      const db = admin.firestore();
      const librarySnap = await db.collection('exerciseLibrary')
        .where('videoPath', '==', path)
        .limit(1)
        .get();

      if (librarySnap.empty) {
        throw new functions.https.HttpsError('permission-denied', 'Access denied to this file');
      }
    }

    const [url] = await storage
      .bucket(BUCKET)
      .file(path)
      .getSignedUrl({
        action: 'read',
        expires: Date.now() + 60 * 60 * 1000, // 1 hour
      });

    return { url };
  }
);
