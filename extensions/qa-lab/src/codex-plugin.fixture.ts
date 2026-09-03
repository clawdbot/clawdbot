// Qa Lab plugin module implements codex plugin.fixture behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveCodexAuthProfile, type QaAuthProfileSnapshot } from "./auth-profile.fixture.js";

export const CODEX_PLUGIN_ID = "codex";

export const CODEX_PLUGIN_LIFECYCLE_MESSAGES = Object.freeze({
  missingPlugin:
    'Codex plugin is required for Codex runtime. Run "openclaw doctor --fix" to install @openclaw/codex, then retry.',
});

export type CodexPluginState = {
  installed: boolean;
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

function codexPluginDir(agentDir: string) {
  return path.join(agentDir, "plugins", CODEX_PLUGIN_ID);
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

export async function removeCodexPluginFixture(agentDir: string): Promise<void> {
  const targetDir = codexPluginDir(agentDir);
  await fs.rm(targetDir, { recursive: true, force: true });
}

export async function installCodexPluginFixture(agentDir: string): Promise<void> {
  const targetDir = codexPluginDir(agentDir);
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(
    path.join(targetDir, "package.json"),
    `${JSON.stringify({ name: "@openclaw/codex" }, null, 2)}\n`,
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
  const installed = await fs.access(packagePath).then(
    () => true,
    (error: unknown) => {
      if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
        return false;
      }
      throw error;
    },
  );
  return { installed };
}

export function evaluateCodexPluginLifecycle(params: {
  plugin: CodexPluginState;
  auth: QaAuthProfileSnapshot;
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

  return {
    status: "ready",
    pluginState: params.plugin,
    selectedAuthProfileId,
    tokenRoute,
    removedRuntimePins,
  };
}
