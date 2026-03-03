import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

/**
 * GCS object finalize trigger.
 * When a video is fully uploaded to GCS, updates the Firestore session document
 * to mark syncStatus as 'synced' and records the videoPath.
 *
 * Path pattern: trainers/{trainerId}/sessions/{sessionId}/recording.{ext}
 */
export const onVideoUploaded = functions.storage
  .bucket(process.env.GCS_BUCKET || 'best-day-training-app.firebasestorage.app')
  .object()
  .onFinalize(async (object) => {
    const filePath = object.name;
    if (!filePath) return;

    // Match: trainers/{trainerId}/sessions/{sessionId}/recording.(webm|mp4)
    const match = filePath.match(/^trainers\/([^/]+)\/sessions\/([^/]+)\/recording\.(webm|mp4)$/);
    if (!match) return;

    const trainerId = match[1];
    const sessionId = match[2];

    const db = admin.firestore();
    const sessionRef = db
      .collection('trainers')
      .doc(trainerId)
      .collection('sessions')
      .doc(sessionId);

    const snap = await sessionRef.get();
    if (!snap.exists) {
      console.warn(`Session ${sessionId} not found in Firestore, skipping GCS trigger update`);
      return;
    }

    await sessionRef.update({
      syncStatus: 'synced',
      videoPath: filePath,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Session ${sessionId} marked as synced (path: ${filePath})`);
  });
