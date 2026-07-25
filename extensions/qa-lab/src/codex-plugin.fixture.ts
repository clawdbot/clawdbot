// Qa Lab plugin module implements codex plugin.fixture behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { compare as compareSemver, parse as parseSemver } from "semver";
import { resolveCodexAuthProfile, type QaAuthProfileSnapshot } from "./auth-profile.fixture.js";

export const CODEX_PLUGIN_CURRENT_VERSION = "2026.5.21";
export const CODEX_PLUGIN_HEAD_VERSION = "head";
export const CODEX_PLUGIN_ID = "codex";

export const CODEX_PLUGIN_LIFECYCLE_MESSAGES = Object.freeze({
  missingPlugin:
    'Codex plugin is required for Codex runtime. Run "openclaw doctor --fix" to install @openclaw/codex, then retry.',
});

export type CodexPluginFixtureVersion = "missing" | "current" | "head" | (string & {});

export type CodexPluginState = {
  installed: boolean;
  version?: string;
};

export type CodexPluginLifecycleStatus = "ready" | "repair-required" | "blocked";

export type CodexPluginLifecycleResult = {
  status: CodexPluginLifecycleStatus;
  pluginState: CodexPluginState;
  selectedAuthProfileId?: string;
  tokenRoute?: "codex-oauth" | "unavailable";
  remediation?: string;
  removedRuntimePins: string[];
};

type CodexPluginPackageJson = {
  name: "@openclaw/codex";
  version: string;
  openclaw: {
    install: {
      minHostVersion: string;
    };
    compat: {
      pluginApi: string;
    };
  };
};

function codexPluginDir(agentDir: string) {
  return path.join(agentDir, "plugins", CODEX_PLUGIN_ID);
}

function resolveFixtureVersion(version: CodexPluginFixtureVersion): string {
  if (version === "current") {
    return CODEX_PLUGIN_CURRENT_VERSION;
  }
  return version;
}

function buildPackageJson(version: string): CodexPluginPackageJson {
  return {
    name: "@openclaw/codex",
    version,
    openclaw: {
      install: {
        minHostVersion: `>=${version === CODEX_PLUGIN_HEAD_VERSION ? CODEX_PLUGIN_CURRENT_VERSION : version}`,
      },
      compat: {
        pluginApi: `>=${version === CODEX_PLUGIN_HEAD_VERSION ? CODEX_PLUGIN_CURRENT_VERSION : version}`,
      },
    },
  };
}

function parseComparableVersion(value: string | undefined) {
  if (!value || value === CODEX_PLUGIN_HEAD_VERSION) {
    return parseComparableVersion(CODEX_PLUGIN_CURRENT_VERSION);
  }
  return parseSemver(value.trim());
}

type ParsedSemver = NonNullable<ReturnType<typeof parseSemver>>;

function compareCodexPluginVersions(left: ParsedSemver, right: ParsedSemver): number {
  const sameCore =
    left.major === right.major && left.minor === right.minor && left.patch === right.patch;
  const leftCorrection =
    left.prerelease.length === 1 && typeof left.prerelease[0] === "number"
      ? left.prerelease[0]
      : null;
  const rightCorrection =
    right.prerelease.length === 1 && typeof right.prerelease[0] === "number"
      ? right.prerelease[0]
      : null;
  if (sameCore && (leftCorrection !== null || rightCorrection !== null)) {
    // OpenClaw numeric suffixes are correction releases after stable, unlike SemVer prereleases.
    const leftRank = leftCorrection !== null ? 2 : left.prerelease.length === 0 ? 1 : 0;
    const rightRank = rightCorrection !== null ? 2 : right.prerelease.length === 0 ? 1 : 0;
    if (leftRank !== rightRank) {
      return leftRank < rightRank ? -1 : 1;
    }
    if (leftCorrection !== null && rightCorrection !== null) {
      return Math.sign(leftCorrection - rightCorrection);
    }
  }
  return compareSemver(left, right);
}

function formatPinnedOldRemediation(pluginVersion: string, hostVersion: string) {
  return `Codex plugin version ${pluginVersion} is older than OpenClaw ${hostVersion}. Run "openclaw plugins update codex" or unpin codex, then rerun "openclaw doctor --fix".`;
}

function formatPinnedNewRemediation(pluginVersion: string, hostVersion: string) {
  return `Codex plugin version ${pluginVersion} requires a newer OpenClaw host than ${hostVersion}. Upgrade OpenClaw or install a codex plugin version pinned to ${hostVersion}.`;
}

function collectStaleLegacyRuntimePins(config: unknown): string[] {
  if (!config || typeof config !== "object") {
    return [];
  }
  const root = config as {
    agents?: {
      defaults?: { agentRuntime?: { id?: unknown } };
      list?: Record<string, { agentRuntime?: { id?: unknown } }>;
    };
  };
  const markers = new Set<string>();
  const collectRuntimePin = (value: unknown) => {
    if (value === "openclaw") {
      markers.add(`agentRuntime.id=${value}`);
    }
  };
  collectRuntimePin(root.agents?.defaults?.agentRuntime?.id);
  for (const entry of Object.values(root.agents?.list ?? {})) {
    collectRuntimePin(entry.agentRuntime?.id);
  }
  return [...markers].toSorted();
}

export async function seedCodexPluginAt(
  version: CodexPluginFixtureVersion,
  agentDir: string,
): Promise<void> {
  const targetDir = codexPluginDir(agentDir);
  await fs.rm(targetDir, { recursive: true, force: true });
  if (version === "missing") {
    return;
  }

  const resolvedVersion = resolveFixtureVersion(version);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(
    path.join(targetDir, "package.json"),
    `${JSON.stringify(buildPackageJson(resolvedVersion), null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(targetDir, "openclaw.plugin.json"),
    `${JSON.stringify({ id: CODEX_PLUGIN_ID, name: "Codex" }, null, 2)}\n`,
    "utf8",
  );
}

export async function snapshotCodexPluginState(agentDir: string): Promise<CodexPluginState> {
  const packagePath = path.join(codexPluginDir(agentDir), "package.json");
  const raw = await fs.readFile(packagePath, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!raw) {
    return { installed: false };
  }

  const parsed = JSON.parse(raw) as { version?: unknown };
  return {
    installed: true,
    ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
  };
}

export function evaluateCodexPluginLifecycle(params: {
  plugin: CodexPluginState;
  auth: QaAuthProfileSnapshot;
  hostVersion: string;
  config?: unknown;
  doctorFix?: boolean;
}): CodexPluginLifecycleResult {
  const authSelection = resolveCodexAuthProfile(params.auth);
  const selectedAuthProfileId =
    authSelection.status === "ready" ? authSelection.profileId : undefined;
  const tokenRoute = authSelection.status === "ready" ? "codex-oauth" : "unavailable";
  const removedRuntimePins = params.doctorFix ? collectStaleLegacyRuntimePins(params.config) : [];

  if (!params.plugin.installed) {
    return {
      status: "repair-required",
      pluginState: params.plugin,
      ...(selectedAuthProfileId ? { selectedAuthProfileId } : {}),
      tokenRoute,
      remediation: CODEX_PLUGIN_LIFECYCLE_MESSAGES.missingPlugin,
      removedRuntimePins,
    };
  }

  if (authSelection.status === "blocked") {
    return {
      status: "blocked",
      pluginState: params.plugin,
      tokenRoute,
      remediation: authSelection.remediation,
      removedRuntimePins,
    };
  }

  const pluginVersion = parseComparableVersion(params.plugin.version);
  const hostVersion = parseComparableVersion(params.hostVersion);
  const versionDelta =
    pluginVersion && hostVersion ? compareCodexPluginVersions(pluginVersion, hostVersion) : 0;
  if (versionDelta < 0 && params.plugin.version) {
    return {
      status: "blocked",
      pluginState: params.plugin,
      selectedAuthProfileId,
      tokenRoute,
      remediation: formatPinnedOldRemediation(params.plugin.version, params.hostVersion),
      removedRuntimePins,
    };
  }
  if (versionDelta > 0 && params.plugin.version) {
    return {
      status: "blocked",
      pluginState: params.plugin,
      selectedAuthProfileId,
      tokenRoute,
      remediation: formatPinnedNewRemediation(params.plugin.version, params.hostVersion),
      removedRuntimePins,
    };
  }

  return {
    status: "ready",
    pluginState: params.plugin,
    selectedAuthProfileId,
    tokenRoute,
    removedRuntimePins,
  };
}
