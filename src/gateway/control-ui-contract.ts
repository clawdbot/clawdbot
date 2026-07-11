// Control UI bootstrap contract served by the gateway and consumed by the
// browser app before it knows runtime branding, media roots, or embed policy.
/** HTTP path for the Control UI bootstrap config payload. */
export const CONTROL_UI_BOOTSTRAP_CONFIG_PATH = "/control-ui-config.json";

/** Carries the gateway-configured Control UI mount path into browser bootstrap. */
export const CONTROL_UI_BASE_PATH_ATTRIBUTE = "data-openclaw-control-ui-base-path";

/** Marks whether the served document CSP permits the terminal WASM runtime. */
export const CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE = "data-openclaw-terminal-enabled";

/** Sandbox policy for assistant-provided embed surfaces inside Control UI. */
export type ControlUiEmbedSandboxMode = "strict" | "scripts" | "trusted";

/** Public GitHub metadata rendered by Control UI link hover cards. */
export type ControlUiGitHubPreview = {
  additions?: number;
  avatarDataUrl?: string;
  changedFiles?: number;
  closedAt?: string;
  comments?: number;
  createdAt: string;
  deletions?: number;
  draft?: boolean;
  kind: "issue" | "pull";
  login: string;
  mergedAt?: string;
  number: number;
  owner: string;
  repo: string;
  state: string;
  stateReason?: string;
  title: string;
  updatedAt: string;
};

// Control UI ships inside the gateway dist, so these payloads move in
// lockstep with the server; shapes here are not independently versioned.
/** Check-run rollup for a PR head commit, chip pill + CI monitoring popover. */
export type ControlUiSessionPullRequestChecks = {
  state: "pending" | "passing" | "failing";
  passed: number;
  failed: number;
  skipped: number;
  /** Queued/in-progress runs plus stale conclusions GitHub invalidated. */
  running: number;
};

/** One GitHub pull request whose head is the session's working branch. */
export type ControlUiSessionPullRequest = {
  number: number;
  owner: string;
  repo: string;
  branch: string;
  title: string;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  additions?: number;
  deletions?: number;
  /** Latest check-run rollup for the head commit; absent when no checks ran. */
  checks?: ControlUiSessionPullRequestChecks;
  checksUrl?: string;
};

/** Pull requests detected for a session's git branch, chip row payload. */
export type ControlUiSessionPullRequests = {
  pullRequests: ControlUiSessionPullRequest[];
  /** GitHub quota exhausted; entries may be stale until the limit resets. */
  rateLimited: boolean;
};

/** Runtime config consumed by the browser Control UI during bootstrap. */
export type ControlUiBootstrapConfig = {
  basePath: string;
  assistantName: string;
  assistantAvatar: string;
  assistantAvatarSource?: string | null;
  assistantAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  assistantAvatarReason?: string | null;
  assistantAgentId: string;
  serverVersion?: string;
  /**
   * Git branch of a source-checkout (non-release) gateway install. Omitted for
   * package installs and mainline (main/master) checkouts so the UI only flags
   * gateways running unreleased branch code.
   */
  devGitBranch?: string;
  localMediaPreviewRoots?: string[];
  embedSandbox?: ControlUiEmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  chatMessageMaxWidth?: string;
  seamColor?: string;
  /** Resolved `agents.defaults.timeFormat`; "auto" keeps the browser locale default. */
  timeFormat?: "auto" | "12" | "24";
  /**
   * Whether the operator terminal surface is enabled (`gateway.terminal.enabled`).
   * The Control UI hides the terminal entirely when false so a disabled kill
   * switch removes the surface rather than showing a button that errors on open.
   */
  terminalEnabled?: boolean;
};
