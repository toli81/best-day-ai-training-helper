import * as functions from 'firebase-functions';
import { Storage } from '@google-cloud/storage';

const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET || 'best-day-training-app.firebasestorage.app';

const ALLOWED_TYPES = ['video/webm', 'video/mp4', 'video/quicktime'];

interface RequestData { path: string; contentType: string }
interface ResponseData { uploadUri: string }

export const getUploadUrl = functions.https.onCall(
  async (data: RequestData, context): Promise<ResponseData> => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
    }

    const { path, contentType } = data;
    const uid = context.auth.uid;

    // Validate ownership
    if (!path.startsWith(`trainers/${uid}/`)) {
      throw new functions.https.HttpsError('permission-denied', 'Can only upload to your own folder');
    }

    // Validate content type
    if (!ALLOWED_TYPES.includes(contentType)) {
      throw new functions.https.HttpsError('invalid-argument', `Invalid content type: ${contentType}`);
    }

    const file = storage.bucket(BUCKET).file(path);

    // Create a resumable upload session
    const [uploadUri] = await file.createResumableUpload({
      metadata: {
        contentType,
        metadata: {
          uploadedBy: uid,
          uploadedAt: new Date().toISOString(),
        },
      },
      origin: '*', // Allow from any origin (lock to your domain in production)
    });

    return { uploadUri };
  }
);
