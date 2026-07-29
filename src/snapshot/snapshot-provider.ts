export const SNAPSHOT_MANIFEST_FILENAME = "manifest.json";
export const SNAPSHOT_SQLITE_FILENAME = "database.sqlite";

export type SnapshotDatabaseIdentity =
  | { readonly role: "global" }
  | { readonly role: "agent"; readonly agentId: string }
  | { readonly role: "generic"; readonly id: string };

export type SnapshotDatabaseRef = {
  readonly path: string;
  readonly identity: SnapshotDatabaseIdentity;
};

export type SnapshotDatabaseManifest =
  | {
      readonly role: "global";
      readonly basename: string;
      readonly userVersion: number;
    }
  | {
      readonly role: "agent";
      readonly agentId: string;
      readonly basename: string;
      readonly userVersion: number;
    }
  | {
      readonly role: "generic";
      readonly id: string;
      readonly basename: string;
      readonly userVersion: number;
    };

export type SnapshotManifest = {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly database: SnapshotDatabaseManifest;
  readonly artifact: {
    readonly path: typeof SNAPSHOT_SQLITE_FILENAME;
    readonly sha256: string;
    readonly sizeBytes: number;
  };
};

export type SnapshotRef = {
  readonly path: string;
};

export type SnapshotResult = {
  readonly ref: SnapshotRef;
  readonly manifest: SnapshotManifest;
};

export type SnapshotVerificationResult = {
  readonly ok: true;
  readonly manifest: SnapshotManifest;
};

export type SnapshotSummary = SnapshotResult;

export type SqliteSnapshotProvider = {
  create(database: SnapshotDatabaseRef): Promise<SnapshotResult>;
  list(): Promise<SnapshotSummary[]>;
  restoreFresh(snapshot: SnapshotRef, targetPath: string): Promise<SnapshotVerificationResult>;
  verify(snapshot: SnapshotRef): Promise<SnapshotVerificationResult>;
};
