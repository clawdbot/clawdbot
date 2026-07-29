// Rejects config files written by unsupported future versions.
import { VERSION } from "../version.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";
import { shouldWarnOnTouchedVersion } from "./version.js";

/** Override env var for intentional older-binary destructive config actions. */
export const ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV =
  "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS";

/** Block payload shown when an older binary would mutate newer-written config. */
export type FutureConfigActionBlock = {
  action: string;
  currentVersion: string;
  touchedVersion: string;
  message: string;
  hints: string[];
};

type FutureConfigGuardParams = {
  action: string;
  snapshot?: Pick<ConfigFileSnapshot, "config" | "sourceConfig"> | null;
  config?: OpenClawConfig | null;
  currentVersion?: string;
  env?: Record<string, string | undefined>;
};

function allowOlderBinaryDestructiveActions(env: Record<string, string | undefined>): boolean {
  const raw = env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function resolveTouchedVersion(params: FutureConfigGuardParams): string | null {
  const readSourceVersion = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const meta = (value as { meta?: unknown }).meta;
    if (!meta || typeof meta !== "object") {
      return undefined;
    }
    const version = (meta as { lastTouchedVersion?: unknown }).lastTouchedVersion;
    return typeof version === "string" ? version.trim() || undefined : undefined;
  };
  return (
    readSourceVersion(params.snapshot?.sourceConfig) ??
    readSourceVersion(params.snapshot?.config) ??
    readSourceVersion(params.config) ??
    null
  );
}

/** Resolves whether a destructive action should be blocked by future config metadata. */
export function resolveFutureConfigActionBlock(
  params: FutureConfigGuardParams,
): FutureConfigActionBlock | null {
  const env = params.env ?? process.env;
  if (allowOlderBinaryDestructiveActions(env)) {
    return null;
  }

  const currentVersion = params.currentVersion ?? VERSION;
  const touchedVersion = resolveTouchedVersion(params);
  if (!touchedVersion || !shouldWarnOnTouchedVersion(currentVersion, touchedVersion)) {
    return null;
  }

  return {
    action: params.action,
    currentVersion,
    touchedVersion,
    message: `Refusing to ${params.action} because this OpenClaw binary (${currentVersion}) is older than the config last written by OpenClaw ${touchedVersion}.`,
    hints: [
      "Run the newer openclaw binary on PATH, or reinstall the intended gateway service from the newer install.",
      `Set ${ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV}=1 only for an intentional downgrade or recovery action.`,
    ],
  };
}

/** Formats a future-config action block for CLI/service error output. */
export function formatFutureConfigActionBlock(block: FutureConfigActionBlock): string {
  return [block.message, ...block.hints].join("\n");
}
