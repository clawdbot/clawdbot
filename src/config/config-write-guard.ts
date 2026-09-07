// Guards config writes when an external deployment owns the config.
import { resolveIsConfigReadOnly, resolveIsNixMode } from "./paths.js";

/** Agent-first Nix install docs shown when runtime config writes are blocked. */
const NIX_OPENCLAW_AGENT_FIRST_URL = "https://github.com/openclaw/nix-openclaw#quick-start";
/** Public OpenClaw Nix overview shown with immutable-config errors. */
const NIX_OVERVIEW_URL = "https://docs.openclaw.ai/install/nix";

/** Error thrown when external management disables config mutation. */
export class ConfigReadOnlyError extends Error {
  readonly code = "OPENCLAW_CONFIG_READONLY";

  constructor(params: { configPath?: string } = {}) {
    super(
      [
        "Config is externally managed (`OPENCLAW_CONFIG_READONLY=1`), so OpenClaw treats openclaw.json as immutable.",
        ...(params.configPath ? [`Config path: ${params.configPath}`] : []),
        "Edit the config in your external deployment source, then redeploy or restart OpenClaw as needed.",
      ].join("\n"),
    );
    this.name = "ConfigReadOnlyError";
  }
}

/** Error thrown when a mutating config path is attempted while Nix owns config state. */
export class NixModeConfigMutationError extends Error {
  readonly code = "OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE";

  constructor(params: { configPath?: string } = {}) {
    super(formatNixModeConfigMutationMessage(params));
    this.name = "NixModeConfigMutationError";
  }
}

/** Build the operator-facing immutable-config message for Nix-managed installs. */
function formatNixModeConfigMutationMessage(params: { configPath?: string } = {}): string {
  return [
    "Config is managed by Nix (`OPENCLAW_NIX_MODE=1`), so OpenClaw treats openclaw.json as immutable.",
    "This usually means nix-openclaw, the first-party Nix distribution, or another Nix-managed package set this mode.",
    ...(params.configPath ? [`Config path: ${params.configPath}`] : []),
    "Do not run setup, onboarding, openclaw update, plugin install/update/uninstall/enable, doctor repair/token-generation, or config set against this file.",
    "Edit the Nix source for this install instead. For nix-openclaw, edit `programs.openclaw.config` or `instances.<name>.config`, then rebuild with Home Manager or NixOS.",
    `Agent-first Nix setup: ${NIX_OPENCLAW_AGENT_FIRST_URL}`,
    `OpenClaw Nix overview: ${NIX_OVERVIEW_URL}`,
  ].join("\n");
}

/** Throw before side effects when the environment marks config as immutable. */
export function assertConfigWriteAllowedInCurrentMode(
  params: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): void {
  if (!resolveIsConfigReadOnly(params.env)) {
    return;
  }
  throw createConfigMutationError(params);
}

/** Select deployment-specific guidance without enabling deployment-specific behavior. */
export function createConfigMutationError(
  params: { configPath?: string; env?: NodeJS.ProcessEnv } = {},
): Error {
  return resolveIsNixMode(params.env)
    ? new NixModeConfigMutationError(params)
    : new ConfigReadOnlyError(params);
}
