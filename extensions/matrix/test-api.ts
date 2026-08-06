// Matrix API module exposes the plugin public contract.
export { matrixPlugin } from "./src/channel.js";
export { MatrixClient } from "./src/matrix/sdk.js";
export {
  openMatrixIdbSnapshotStoreOptions,
  openMatrixRecoveryKeyStoreOptions,
} from "./src/matrix/crypto-state-store.js";
export {
  normalizeMatrixStorageMetadata,
  openMatrixStorageMetaStoreOptions,
} from "./src/matrix/client/storage.js";
export type { MatrixStorageMetadata } from "./src/matrix/client/storage.js";
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
