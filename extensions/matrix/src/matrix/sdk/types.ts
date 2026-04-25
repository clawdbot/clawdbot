import type { MatrixSyncState } from "../sync-state.js";
import type {
  MatrixVerificationRequestLike,
  MatrixVerificationSummary,
} from "./verification-manager.js";

export type MatrixRawEvent = {
  event_id: string;
  sender: string;
  type: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  unsigned?: {
    age?: number;
    "m.relations"?: Record<string, unknown>;
    redacted_because?: unknown;
  };
  state_key?: string;
};

export type MatrixRelationsPage = {
  originalEvent?: MatrixRawEvent | null;
  events: MatrixRawEvent[];
  nextBatch?: string | null;
  prevBatch?: string | null;
};

export type MatrixClientEventMap = {
  "room.event": [roomId: string, event: MatrixRawEvent];
  "room.message": [roomId: string, event: MatrixRawEvent];
  "room.encrypted_event": [roomId: string, event: MatrixRawEvent];
  "room.decrypted_event": [roomId: string, event: MatrixRawEvent];
  "room.failed_decryption": [roomId: string, event: MatrixRawEvent, error: Error];
  "room.invite": [roomId: string, event: MatrixRawEvent];
  "room.join": [roomId: string, event: MatrixRawEvent];
  "sync.state": [state: MatrixSyncState, prevState: string | null, error?: unknown];
  "sync.unexpected_error": [error: Error];
  "verification.summary": [summary: MatrixVerificationSummary];
};

export type EncryptedFile = {
  url: string;
  key: {
    kty: string;
    key_ops: string[];
    alg: string;
    k: string;
    ext: boolean;
  };
  iv: string;
  hashes: Record<string, string>;
  v: string;
};

export type FileWithThumbnailInfo = {
  size?: number;
  mimetype?: string;
  thumbnail_url?: string;
  thumbnail_file?: EncryptedFile;
  thumbnail_info?: {
    w?: number;
    h?: number;
    mimetype?: string;
    size?: number;
  };
};

export type DimensionalFileInfo = FileWithThumbnailInfo & {
  w?: number;
  h?: number;
};

export type TimedFileInfo = FileWithThumbnailInfo & {
  duration?: number;
};

export type VideoFileInfo = DimensionalFileInfo &
  TimedFileInfo & {
    duration?: number;
  };

export type MessageEventContent = {
  msgtype?: string;
  body?: string;
  format?: string;
  formatted_body?: string;
  filename?: string;
  url?: string;
  file?: EncryptedFile;
  info?: Record<string, unknown>;
  "m.relates_to"?: Record<string, unknown>;
  "m.new_content"?: unknown;
  "m.mentions"?: {
    user_ids?: string[];
    room?: boolean;
  };
  [key: string]: unknown;
};

export type TextualMessageEventContent = MessageEventContent & {
  msgtype: string;
  body: string;
};

export type LocationMessageEventContent = MessageEventContent & {
  msgtype?: string;
  geo_uri?: string;
};

export type MatrixSecretStorageStatus = {
  ready: boolean;
  defaultKeyId: string | null;
  secretStorageKeyValidityMap?: Record<string, boolean>;
};

export type MatrixGeneratedSecretStorageKey = {
  keyId?: string | null;
  keyInfo?: {
    passphrase?: unknown;
    name?: string;
  };
  privateKey: Uint8Array;
  encodedPrivateKey?: string;
};

export type MatrixDeviceVerificationStatusLike = {
  isVerified?: () => boolean;
  localVerified?: boolean;
  crossSigningVerified?: boolean;
  signedByOwner?: boolean;
};

export type MatrixKeyBackupInfo = {
  algorithm: string;
  auth_data: Record<string, unknown>;
  count?: number;
  etag?: string;
  version?: string;
};

export type MatrixKeyBackupTrustInfo = {
  trusted: boolean;
  matchesDecryptionKey: boolean;
};

export type MatrixRoomKeyBackupRestoreResult = {
  total: number;
  imported: number;
};

export type MatrixImportRoomKeyProgress = {
  stage: string;
  successes?: number;
  failures?: number;
  total?: number;
};

export type MatrixSecretStorageKeyDescription = {
  passphrase?: unknown;
  name?: string;
  [key: string]: unknown;
};

export type MatrixCryptoCallbacks = {
  getSecretStorageKey?: (
    params: { keys: Record<string, MatrixSecretStorageKeyDescription> },
    name: string,
  ) => Promise<[string, Uint8Array] | null>;
  cacheSecretStorageKey?: (
    keyId: string,
    keyInfo: MatrixSecretStorageKeyDescription,
    key: Uint8Array,
  ) => void;
};

export type MatrixStoredRecoveryKey = {
  version: 1;
  createdAt: string;
  keyId?: string | null;
  encodedPrivateKey?: string;
  privateKeyBase64: string;
  keyInfo?: {
    passphrase?: unknown;
    name?: string;
  };
};

export type MatrixAuthDict = Record<string, unknown>;

export type MatrixUiAuthCallback = <T>(
  makeRequest: (authData: MatrixAuthDict | null) => Promise<T>,
) => Promise<T>;

export type MatrixCryptoBootstrapApi = {
  on: (eventName: string, listener: (...args: unknown[]) => void) => void;
  bootstrapCrossSigning: (opts: {
    setupNewCrossSigning?: boolean;
    authUploadDeviceSigningKeys?: MatrixUiAuthCallback;
  }) => Promise<void>;
  bootstrapSecretStorage: (opts?: {
    createSecretStorageKey?: () => Promise<MatrixGeneratedSecretStorageKey>;
    setupNewSecretStorage?: boolean;
    setupNewKeyBackup?: boolean;
  }) => Promise<void>;
  createRecoveryKeyFromPassphrase?: (password?: string) => Promise<MatrixGeneratedSecretStorageKey>;
  getSecretStorageStatus?: () => Promise<MatrixSecretStorageStatus>;
  requestOwnUserVerification: () => Promise<MatrixVerificationRequestLike | null>;
  findVerificationRequestDMInProgress?: (
    roomId: string,
    userId: string,
  ) => MatrixVerificationRequestLike | undefined;
  requestDeviceVerification?: (
    userId: string,
    deviceId: string,
  ) => Promise<MatrixVerificationRequestLike>;
  requestVerificationDM?: (
    userId: string,
    roomId: string,
  ) => Promise<MatrixVerificationRequestLike>;
  getDeviceVerificationStatus?: (
    userId: string,
    deviceId: string,
  ) => Promise<MatrixDeviceVerificationStatusLike | null>;
  getSessionBackupPrivateKey?: () => Promise<Uint8Array | null>;
  loadSessionBackupPrivateKeyFromSecretStorage?: () => Promise<void>;
  getActiveSessionBackupVersion?: () => Promise<string | null>;
  getKeyBackupInfo?: () => Promise<MatrixKeyBackupInfo | null>;
  isKeyBackupTrusted?: (info: MatrixKeyBackupInfo) => Promise<MatrixKeyBackupTrustInfo>;
  checkKeyBackupAndEnable?: () => Promise<unknown>;
  restoreKeyBackup?: (opts?: {
    progressCallback?: (progress: MatrixImportRoomKeyProgress) => void;
  }) => Promise<MatrixRoomKeyBackupRestoreResult>;
  setDeviceVerified?: (userId: string, deviceId: string, verified?: boolean) => Promise<void>;
  crossSignDevice?: (deviceId: string) => Promise<void>;
  getOwnIdentity?: () => Promise<
    | {
        free?: () => void;
        isVerified?: () => boolean;
        verify?: () => Promise<unknown>;
      }
    | undefined
  >;
  isCrossSigningReady?: () => Promise<boolean>;
  userHasCrossSigningKeys?: (userId?: string, downloadUncached?: boolean) => Promise<boolean>;
};
