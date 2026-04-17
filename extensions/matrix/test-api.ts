export { matrixPlugin } from "./src/channel.js";
export { MatrixClient } from "./src/matrix/sdk.js";
export type {
  EncryptedFile,
  MatrixDeviceVerificationStatus,
  MatrixOwnDeviceDeleteResult,
  MatrixOwnDeviceInfo,
  MatrixOwnDeviceVerificationStatus,
  MatrixRecoveryKeyVerificationResult,
  MatrixRawEvent,
  MatrixRoomKeyBackupResetResult,
  MatrixRoomKeyBackupRestoreResult,
  MatrixRoomKeyBackupStatus,
  MatrixVerificationBootstrapResult,
  MessageEventContent,
} from "./src/matrix/sdk.js";
export type {
  MatrixVerificationMethod,
  MatrixVerificationSummary,
} from "./src/matrix/sdk/verification-manager.js";
export { setMatrixRuntime } from "./src/runtime.js";
