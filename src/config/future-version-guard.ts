import { VERSION } from "../version.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";
import { shouldWarnOnTouchedVersion } from "./version.js";

export const ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV =
  "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS";

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
  config?: Pick<OpenClawConfig, "meta"> | null;
  currentVersion?: string;
  env?: Record<string, string | undefined>;
};

function allowOlderBinaryDestructiveActions(env: Record<string, string | undefined>): boolean {
  const raw = env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function resolveTouchedVersion(params: FutureConfigGuardParams): string | null {
  return (
    params.snapshot?.sourceConfig?.meta?.lastTouchedVersion?.trim() ||
    params.snapshot?.config?.meta?.lastTouchedVersion?.trim() ||
    params.config?.meta?.lastTouchedVersion?.trim() ||
    null
  );
}

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

export function formatFutureConfigActionBlock(block: FutureConfigActionBlock): string {
  return [block.message, ...block.hints].join("\n");
}
