/** HTTP path for the Control UI bootstrap config payload. */
export const CONTROL_UI_BOOTSTRAP_CONFIG_PATH = "/control-ui-config.json";

/** Fragment marker selecting the host-authorized browser-owner bootstrap profile. */
export const CONTROL_UI_BOOTSTRAP_PROFILE_FRAGMENT_PARAM = "bootstrapProfile";
export const CONTROL_UI_OWNER_BOOTSTRAP_PROFILE_HINT = "owner";
export type ControlUiBootstrapProfileHint = typeof CONTROL_UI_OWNER_BOOTSTRAP_PROFILE_HINT;

/** Carries the gateway-configured Control UI mount path into browser bootstrap. */
export const CONTROL_UI_BASE_PATH_ATTRIBUTE = "data-openclaw-control-ui-base-path";

/** Marks whether the served document CSP permits the terminal WASM runtime. */
export const CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE = "data-openclaw-terminal-enabled";

export const CONTROL_UI_ENVIRONMENT_ATTRIBUTE = "data-openclaw-environment";
export const CONTROL_UI_ENVIRONMENT_COLORS = [
  "teal",
  "amber",
  "purple",
  "coral",
  "pink",
  "blue",
  "green",
  "red",
  "gray",
] as const;
export type ControlUiEnvironment = {
  label: string;
  color: (typeof CONTROL_UI_ENVIRONMENT_COLORS)[number];
};

/** Sandbox policy for assistant-provided embed surfaces inside Control UI. */
export type ControlUiEmbedSandboxMode = "strict" | "scripts" | "trusted";

/** Route grant successfully issued during authenticated Control UI bootstrap. */
export type ControlUiPluginFrameGrantAck = {
  pluginId: string;
  path: string;
  match: "exact" | "prefix";
};

/** Runtime config consumed by the browser Control UI during bootstrap. */
export type ControlUiBootstrapConfig = {
  basePath: string;
  assistantName: string;
  assistantAvatar: string;
  assistantAvatarSource?: string | null;
  assistantAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  assistantAvatarReason?: string | null;
  assistantAgentId?: string;
  serverVersion?: string;
  /** Exact immutable build serving this Control UI when available. */
  serverBuildId?: string;
  /**
   * Git branch of a source-checkout (non-release) gateway install. Omitted for
   * package installs and mainline (main/master) checkouts so the UI only flags
   * gateways running unreleased branch code.
   */
  devGitBranch?: string;
  embedSandbox?: ControlUiEmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  automaticallyFetchFavicons?: boolean;
  seamColor?: string;
  environment?: ControlUiEnvironment;
  /** Whether this Gateway's served UI may show the Discord community invitation. */
  communityInvite?: boolean;
  /**
   * Whether the operator terminal surface is enabled (`gateway.terminal.enabled`).
   * The Control UI hides the terminal entirely when false so a disabled kill
   * switch removes the surface rather than showing a button that errors on open.
   */
  terminalEnabled?: boolean;
  /** Whether the Labs-gated CLI agents model-picker group is enabled. */
  cliAgentsEnabled?: boolean;
  /** Only explicit no-auth Gateways permit native asset loading without scoped cookies. */
  pluginAssetsRequireAuth?: boolean;
  pluginFrameGrants?: ControlUiPluginFrameGrantAck[];
};
