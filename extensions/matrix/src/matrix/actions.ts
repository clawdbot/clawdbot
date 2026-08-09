// Matrix plugin module implements actions behavior.
export {
  sendMatrixMessage,
  editMatrixMessage,
  deleteMatrixMessage,
  readMatrixMessages,
} from "./actions/messages.js";
export { voteMatrixPoll } from "./actions/polls.js";
export { listMatrixReactions, removeMatrixReactions } from "./actions/reactions.js";
export { pinMatrixMessage, unpinMatrixMessage, listMatrixPins } from "./actions/pins.js";
export { getMatrixMemberInfo, getMatrixRoomInfo } from "./actions/room.js";
export {
  bootstrapMatrixVerification,
  acceptMatrixVerification,
  cancelMatrixVerification,
  confirmMatrixVerificationReciprocateQr,
  confirmMatrixVerificationSas,
  generateMatrixVerificationQr,
  getMatrixEncryptionStatus,
  getMatrixRoomKeyBackupStatus,
  getMatrixVerificationStatus,
  getMatrixVerificationSas,
  listMatrixVerifications,
  mismatchMatrixVerificationSas,
  requestMatrixVerification,
  restoreMatrixRoomKeyBackup,
  scanMatrixVerificationQr,
  startMatrixVerification,
  verifyMatrixRecoveryKey,
} from "./actions/verification.js";
