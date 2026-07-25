// Guards config writes that are disallowed in Nix-managed installs.
import path from "node:path";
import { resolveConfigPath, resolveIsNixMode } from "./paths.js";

/** Agent-first Nix install docs shown when runtime config writes are blocked. */
const NIX_OPENCLAW_AGENT_FIRST_URL = "https://github.com/openclaw/nix-openclaw#quick-start";
/** Public OpenClaw Nix overview shown with immutable-config errors. */
const OPENCLAW_NIX_OVERVIEW_URL = "https://docs.openclaw.ai/install/nix";

type RuntimeConfigWriteBlock = { configPath: string; reason: string };

const runtimeConfigWriteBlocks = new Set<RuntimeConfigWriteBlock>();

/** Block persistence to one runtime-owned config path until cleanup. */
export function blockConfigWritesForRuntime(params: RuntimeConfigWriteBlock): () => void {
  const block = { ...params, configPath: path.resolve(params.configPath) };
  runtimeConfigWriteBlocks.add(block);
  return () => {
    runtimeConfigWriteBlocks.delete(block);
  };
}

/** Error thrown when runtime ownership makes the canonical config immutable. */
export class RuntimeConfigMutationBlockedError extends Error {
  readonly code = "OPENCLAW_CONFIG_RUNTIME_IMMUTABLE";

  constructor(reason: string, configPath?: string) {
    super([reason, ...(configPath ? [`Config path: ${configPath}`] : [])].join("\n"));
    this.name = "RuntimeConfigMutationBlockedError";
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
    `OpenClaw Nix overview: ${OPENCLAW_NIX_OVERVIEW_URL}`,
  ].join("\n");
}

/** Throw when the current environment marks OpenClaw config as Nix-managed and immutable. */
export function assertConfigWriteAllowedInCurrentMode(
  params: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): void {
  const resolvedConfigPath = path.resolve(params.configPath ?? resolveConfigPath(params.env));
  const runtimeConfigWriteBlock = Array.from(runtimeConfigWriteBlocks).find(
    (block) => block.configPath === resolvedConfigPath,
  );
  if (runtimeConfigWriteBlock) {
    throw new RuntimeConfigMutationBlockedError(runtimeConfigWriteBlock.reason, params.configPath);
  }
  if (!resolveIsNixMode(params.env)) {
    return;
  }
  // In Nix mode, all writes must happen in the declarative source and then rebuild.
  throw new NixModeConfigMutationError({ configPath: params.configPath });
}
