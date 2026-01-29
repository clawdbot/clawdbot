/**
 * Workspace sync provider modes.
 * - off: no sync
 * - dropbox: Dropbox via rclone
 * - gdrive: Google Drive via rclone
 * - onedrive: OneDrive via rclone
 * - s3: S3-compatible storage via rclone
 * - custom: custom rclone remote (user-configured)
 */
export type WorkspaceSyncProvider = "off" | "dropbox" | "gdrive" | "onedrive" | "s3" | "custom";

/**
 * Workspace sync configuration.
 * Enables bidirectional sync between the agent workspace and cloud storage.
 */
export type WorkspaceSyncConfig = {
  /**
   * Sync provider mode.
   * - off: disabled (default)
   * - dropbox: Dropbox via rclone
   * - gdrive: Google Drive via rclone
   * - onedrive: OneDrive via rclone
   * - s3: S3-compatible storage via rclone
   * - custom: custom rclone remote
   */
  provider?: WorkspaceSyncProvider;

  /**
   * Remote path/folder in cloud storage (e.g., "moltbot-share").
   * For Dropbox App folders, this is relative to the app folder root.
   */
  remotePath?: string;

  /**
   * Local subfolder within workspace to sync (default: "shared").
   * Files outside this folder are not synced.
   */
  localPath?: string;

  /**
   * Sync interval in seconds (0 = manual only, default: 0).
   * When > 0, the gateway runs rclone bisync in the background at this interval.
   * This is a pure file operation - it does NOT wake the bot or incur LLM costs.
   */
  interval?: number;

  /**
   * Sync on session start (default: false).
   */
  onSessionStart?: boolean;

  /**
   * Sync on session end (default: false).
   */
  onSessionEnd?: boolean;

  /**
   * rclone remote name (default: "cloud").
   * Used when provider is "custom" or to override the auto-generated name.
   */
  remoteName?: string;

  /**
   * Path to rclone config file.
   * Default: $CLAWDBOT_STATE_DIR/.config/rclone/rclone.conf
   */
  configPath?: string;

  /**
   * Conflict resolution strategy.
   * - newer: keep the newer file, rename older with .conflict suffix
   * - local: local wins, remote gets .conflict suffix
   * - remote: remote wins, local gets .conflict suffix
   */
  conflictResolve?: "newer" | "local" | "remote";

  /**
   * File patterns to exclude from sync (glob patterns).
   * Defaults include: .git/**, node_modules/**, .venv/**, *.log, .DS_Store
   */
  exclude?: string[];

  /**
   * Follow symlinks during sync (default: false).
   * When false, symlinks are skipped with a notice.
   * When true, symlinks are followed and their targets are copied.
   */
  copySymlinks?: boolean;

  /**
   * S3-specific configuration (when provider is "s3").
   */
  s3?: {
    /** S3 endpoint URL (for non-AWS S3-compatible services). */
    endpoint?: string;
    /** S3 bucket name. */
    bucket?: string;
    /** S3 region. */
    region?: string;
    /** Access key ID (prefer env var S3_ACCESS_KEY_ID). */
    accessKeyId?: string;
    /** Secret access key (prefer env var S3_SECRET_ACCESS_KEY). */
    secretAccessKey?: string;
  };

  /**
   * Dropbox-specific configuration.
   */
  dropbox?: {
    /** Use app folder access (more secure, limited to Apps/<app-name>/). */
    appFolder?: boolean;
    /** Dropbox app key / client_id. */
    appKey?: string;
    /** Dropbox app secret / client_secret. */
    appSecret?: string;
    /** OAuth token JSON (prefer env var ${DROPBOX_TOKEN}). */
    token?: string;
  };
};

/**
 * Top-level workspace configuration.
 */
export type WorkspaceConfig = {
  /**
   * Cloud sync configuration for bidirectional workspace sync.
   */
  sync?: WorkspaceSyncConfig;
};
