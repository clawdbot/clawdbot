// Qa Lab plugin module implements codex plugin.fixture behavior.
import fs from "node:fs/promises";
import path from "node:path";
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

type ComparableVersion = {
  major: number;
  minor: number;
  patch: number;
};

type CodexPluginInstallGateResult = {
  text: string;
  inputTokens: number;
  responseCount: number;
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

function parseComparableVersion(value: string | undefined): ComparableVersion | null {
  if (!value || value === CODEX_PLUGIN_HEAD_VERSION) {
    return parseComparableVersion(CODEX_PLUGIN_CURRENT_VERSION);
  }
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1] ?? "0", 10),
    minor: Number.parseInt(match[2] ?? "0", 10),
    patch: Number.parseInt(match[3] ?? "0", 10),
  };
}

function compareVersions(left: string | undefined, right: string): number {
  const leftVersion = parseComparableVersion(left);
  const rightVersion = parseComparableVersion(right);
  if (!leftVersion || !rightVersion) {
    return 0;
  }
  if (leftVersion.major !== rightVersion.major) {
    return leftVersion.major - rightVersion.major;
  }
  if (leftVersion.minor !== rightVersion.minor) {
    return leftVersion.minor - rightVersion.minor;
  }
  return leftVersion.patch - rightVersion.patch;
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

  const versionDelta = compareVersions(params.plugin.version, params.hostVersion);
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

export function createCodexPluginInstallGate() {
  const events: string[] = [];
  let installed = false;
  let resolveInstall: (() => void) | undefined;
  const installedPromise = new Promise<void>((resolve) => {
    resolveInstall = resolve;
  });

  return {
    events,
    markInstalled() {
      if (installed) {
        return;
      }
      installed = true;
      events.push("codex-plugin:installed");
      resolveInstall?.();
    },
    async runFirstTurnAfterInstall(params: {
      inputTokens: number;
      run: () => string | Promise<string>;
    }): Promise<CodexPluginInstallGateResult> {
      if (!installed) {
        events.push("agent-turn:waiting-for-codex-plugin");
        await installedPromise;
      }
      events.push("agent-turn:started");
      const text = await params.run();
      events.push("agent-turn:completed");
      return {
        text,
        inputTokens: params.inputTokens,
        responseCount: 1,
      };
    },
  };
}
