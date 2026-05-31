import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  QA_CODEX_OAUTH_PROFILE_ID,
  QA_OPENAI_API_KEY_PROFILE_ID,
  resolveCodexAuthProfile,
  seedAuthProfiles,
  snapshotAuthProfiles,
} from "./auth-profile.fixture.js";
import {
  CODEX_PLUGIN_CURRENT_VERSION,
  CODEX_PLUGIN_LIFECYCLE_MESSAGES,
  createCodexPluginInstallGate,
  evaluateCodexPluginLifecycle,
  seedCodexPluginAt,
  snapshotCodexPluginState,
} from "./codex-plugin.fixture.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();

async function createAgentDir(prefix: string) {
  const root = await tempDirs.makeTempDir(prefix);
  const agentDir = path.join(root, "agents", "qa", "agent");
  await fs.mkdir(agentDir, { recursive: true });
  return agentDir;
}

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("codex plugin lifecycle: cold install", () => {
  it("repairs a missing codex plugin before the retry succeeds without leaking to the API-key path", async () => {
    const agentDir = await createAgentDir("qa-codex-plugin-cold-");
    await seedCodexPluginAt("missing", agentDir);
    await seedAuthProfiles("mixed", agentDir);

    const missing = evaluateCodexPluginLifecycle({
      plugin: await snapshotCodexPluginState(agentDir),
      auth: await snapshotAuthProfiles(agentDir),
      hostVersion: CODEX_PLUGIN_CURRENT_VERSION,
    });

    expect(missing.status).toBe("repair-required");
    expect(missing.remediation).toBe(CODEX_PLUGIN_LIFECYCLE_MESSAGES.missingPlugin);
    expect(missing.selectedAuthProfileId).toBe(QA_CODEX_OAUTH_PROFILE_ID);
    expect(missing.selectedAuthProfileId).not.toBe(QA_OPENAI_API_KEY_PROFILE_ID);

    await seedCodexPluginAt("current", agentDir);
    const repaired = evaluateCodexPluginLifecycle({
      plugin: await snapshotCodexPluginState(agentDir),
      auth: await snapshotAuthProfiles(agentDir),
      hostVersion: CODEX_PLUGIN_CURRENT_VERSION,
    });

    expect(repaired.status).toBe("ready");
    expect(repaired.remediation).toBeUndefined();
    expect(repaired.tokenRoute).toBe("codex-oauth");
  });
});

describe("codex plugin lifecycle: OAuth-only with mixed profiles", () => {
  it("selects openai OAuth when openai API-key profiles are present", async () => {
    const agentDir = await createAgentDir("qa-codex-auth-mixed-");
    await seedAuthProfiles("mixed", agentDir);

    const selection = resolveCodexAuthProfile(await snapshotAuthProfiles(agentDir));

    expect(selection.status).toBe("ready");
    if (selection.status !== "ready") {
      throw new Error(selection.remediation);
    }
    expect(selection.profileId).toBe(QA_CODEX_OAUTH_PROFILE_ID);
    expect(selection.profileId).not.toBe(QA_OPENAI_API_KEY_PROFILE_ID);
    expect(selection.provider).toBe("openai");
    expect(selection.mode).toBe("oauth");
  });
});

describe("codex plugin lifecycle: pinned-old codex plugin with new OpenClaw", () => {
  it("blocks with a precise update remediation when the plugin is older than the host", async () => {
    const agentDir = await createAgentDir("qa-codex-plugin-old-");
    await seedCodexPluginAt("2026.5.19", agentDir);
    await seedAuthProfiles("oauth-only", agentDir);

    const result = evaluateCodexPluginLifecycle({
      plugin: await snapshotCodexPluginState(agentDir),
      auth: await snapshotAuthProfiles(agentDir),
      hostVersion: "2026.5.21",
    });

    expect(result.status).toBe("blocked");
    expect(result.remediation).toBe(
      'Codex plugin version 2026.5.19 is older than OpenClaw 2026.5.21. Run "openclaw plugins update codex" or unpin codex, then rerun "openclaw doctor --fix".',
    );
  });
});

describe("codex plugin lifecycle: pinned-new codex plugin with old OpenClaw", () => {
  it("blocks with a precise host-upgrade remediation when the plugin is newer than the host", async () => {
    const agentDir = await createAgentDir("qa-codex-plugin-new-");
    await seedCodexPluginAt("2026.5.22", agentDir);
    await seedAuthProfiles("oauth-only", agentDir);

    const result = evaluateCodexPluginLifecycle({
      plugin: await snapshotCodexPluginState(agentDir),
      auth: await snapshotAuthProfiles(agentDir),
      hostVersion: "2026.5.21",
    });

    expect(result.status).toBe("blocked");
    expect(result.remediation).toBe(
      "Codex plugin version 2026.5.22 requires a newer OpenClaw host than 2026.5.21. Upgrade OpenClaw or install a codex plugin version pinned to 2026.5.21.",
    );
  });
});

describe("codex plugin lifecycle: install racing first agent turn", () => {
  it("gates the first turn on install completion without sleeps, lost tokens, or duplicate responses", async () => {
    const gate = createCodexPluginInstallGate();
    const turn = gate.runFirstTurnAfterInstall({
      inputTokens: 17,
      run: () => "QA_CODEX_PLUGIN_TURN_OK",
    });

    expect(gate.events).toEqual(["agent-turn:waiting-for-codex-plugin"]);

    gate.markInstalled();
    await expect(turn).resolves.toEqual({
      text: "QA_CODEX_PLUGIN_TURN_OK",
      inputTokens: 17,
      responseCount: 1,
    });
    expect(gate.events).toEqual([
      "agent-turn:waiting-for-codex-plugin",
      "codex-plugin:installed",
      "agent-turn:started",
      "agent-turn:completed",
    ]);
  });
});

describe("codex plugin lifecycle: doctor migration safety matrix", () => {
  it.each([
    {
      name: "oauth-only host",
      profileShape: "oauth-only" as const,
      config: {},
    },
    {
      name: "mixed profile with no pin",
      profileShape: "mixed" as const,
      config: {},
    },
    {
      name: "mixed profile with defaults OpenClaw pin",
      profileShape: "mixed" as const,
      config: { agents: { defaults: { agentRuntime: { id: "openclaw" } } } },
      expectedRemovedRuntimePins: ["agentRuntime.id=openclaw"],
    },
    {
      name: "mixed profile with main-agent OpenClaw pin",
      profileShape: "mixed" as const,
      config: { agents: { list: { main: { agentRuntime: { id: "openclaw" } } } } },
      expectedRemovedRuntimePins: ["agentRuntime.id=openclaw"],
    },
  ])(
    "keeps codex auth and strips stale OpenClaw runtime pins for $name",
    async ({ profileShape, config, expectedRemovedRuntimePins = [] }) => {
      const agentDir = await createAgentDir("qa-codex-doctor-matrix-");
      await seedCodexPluginAt("current", agentDir);
      await seedAuthProfiles(profileShape, agentDir);

      const result = evaluateCodexPluginLifecycle({
        plugin: await snapshotCodexPluginState(agentDir),
        auth: await snapshotAuthProfiles(agentDir),
        hostVersion: CODEX_PLUGIN_CURRENT_VERSION,
        config,
        doctorFix: true,
      });

      expect(result.status).toBe("ready");
      expect(result.selectedAuthProfileId).toBe(QA_CODEX_OAUTH_PROFILE_ID);
      expect(result.tokenRoute).toBe("codex-oauth");
      expect(result.removedRuntimePins).toEqual(expectedRemovedRuntimePins);
    },
  );
});
