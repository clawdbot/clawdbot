import { afterEach, describe, expect, it, vi } from "vitest";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";

const loadPluginManifestRegistry = vi.hoisted(() => vi.fn(() => ({ plugins: [] })));

vi.mock("../infra/git-commit.js", () => ({
  resolveCommitHash: () => "abcdef0",
}));

vi.mock("../infra/os-summary.js", () => ({
  resolveOsSummary: () => ({
    platform: "darwin",
    arch: "arm64",
    release: "test-release",
    label: "test-os",
  }),
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: loadPluginManifestRegistry,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: () => {
    const registry = loadPluginManifestRegistry();
    return {
      plugins: registry.plugins,
      manifestRegistry: registry,
    };
  },
}));

import { buildTrajectoryArtifacts, buildTrajectoryRunMetadata } from "./metadata.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("trajectory metadata", () => {
  it("redacts harness argv and local paths with the support redaction rules", () => {
    const originalArgv = process.argv;
    process.argv = [
      "node",
      "/Users/tester/project/openclaw.js",
      "--api-key",
      "super-secret",
      "--config=/Users/tester/.openclaw/openclaw.json",
    ];
    try {
      const metadata = buildTrajectoryRunMetadata({
        env: {
          HOME: "/Users/tester",
          OPENCLAW_STATE_DIR: "/Users/tester/.openclaw",
        },
        workspaceDir: "/Users/tester/project",
        sessionFile: "/Users/tester/project/session.jsonl",
        timeoutMs: 30_000,
      });

      const harness = metadata.harness as {
        invocation?: unknown[];
        entrypoint?: string;
        workspaceDir?: string;
        sessionFile?: string;
      };
      expect(harness.invocation).toEqual([
        "node",
        "~/project/openclaw.js",
        "--api-key",
        "<redacted>",
        "--config=$OPENCLAW_STATE_DIR/openclaw.json",
      ]);
      expect(harness.entrypoint).toBe("~/project/openclaw.js");
      expect(harness.workspaceDir).toBe("~/project");
      expect(harness.sessionFile).toBe("~/project/session.jsonl");
    } finally {
      process.argv = originalArgv;
    }
  });

  it("captures redacted config plus active plugin and skill inventory", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({
      id: "demo-plugin",
      name: "Demo Plugin",
      version: "1.2.3",
      source: "bundled",
      origin: "bundled",
      enabled: true,
      activated: true,
      imported: true,
      status: "loaded",
      toolNames: ["demo_tool"],
      hookNames: [],
      channelIds: ["demo-channel"],
      cliBackendIds: [],
      providerIds: ["demo-provider"],
      speechProviderIds: [],
      realtimeTranscriptionProviderIds: [],
      realtimeVoiceProviderIds: [],
      mediaUnderstandingProviderIds: [],
      imageGenerationProviderIds: [],
      videoGenerationProviderIds: [],
      musicGenerationProviderIds: [],
      webFetchProviderIds: [],
      webSearchProviderIds: [],
      migrationProviderIds: [],
      memoryEmbeddingProviderIds: [],
      agentHarnessIds: ["pi"],
      gatewayMethods: [],
      cliCommands: [],
      services: [],
      gatewayDiscoveryServiceIds: [],
      commands: [],
      httpRoutes: 0,
      hookCount: 0,
      configSchema: false,
    });
    setActivePluginRegistry(registry, "trajectory-metadata-test");

    const metadata = buildTrajectoryRunMetadata({
      config: {
        providers: {
          openai: {
            apiKey: "super-secret",
          },
        },
      } as never,
      workspaceDir: "/tmp/workspace",
      sessionFile: "/tmp/workspace/session.jsonl",
      sessionKey: "agent:main:test",
      agentId: "main",
      trigger: "user",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "responses",
      timeoutMs: 30_000,
      reasoningLevel: "high",
      skillsSnapshot: {
        prompt: "skill prompt",
        version: 1,
        skills: [{ name: "weather" }],
        resolvedSkills: [
          {
            name: "weather",
            description: "Check weather",
            filePath: "/tmp/workspace/skills/weather/SKILL.md",
            baseDir: "/tmp/workspace/skills/weather",
            source: "workspace",
            sourceInfo: {
              path: "/tmp/workspace/skills/weather/SKILL.md",
              source: "workspace",
              scope: "project",
              origin: "top-level",
              baseDir: "/tmp/workspace/skills/weather",
            },
            disableModelInvocation: false,
          },
        ],
      },
      userPromptPrefixText: "prefix",
    });

    const config = metadata.config as {
      redacted?: { providers?: { openai?: { apiKey?: string } } };
    };
    const plugins = metadata.plugins as { source?: string; entries?: Array<{ id: string }> };
    const skills = metadata.skills as { entries?: Array<{ id: string; filePath?: string }> };
    expect(config.redacted?.providers?.openai?.apiKey).toBe(REDACTED_SENTINEL);
    expect(plugins.source).toBe("active-registry");
    expect(plugins.entries?.map((entry) => entry.id)).toEqual(["demo-plugin"]);
    expect(skills.entries?.[0]).toMatchObject({
      id: "weather",
      filePath: "/tmp/workspace/skills/weather/SKILL.md",
    });
  });

  it("captures final artifact summaries for export sidecars", () => {
    const artifacts = buildTrajectoryArtifacts({
      status: "success",
      aborted: false,
      externalAbort: false,
      timedOut: false,
      idleTimedOut: false,
      timedOutDuringCompaction: false,
      timedOutDuringToolExecution: false,
      compactionCount: 1,
      assistantTexts: ["done"],
      finalPromptText: "run tests",
      itemLifecycle: {
        startedCount: 2,
        completedCount: 2,
        activeCount: 0,
      },
      toolMetas: [{ toolName: "bash", meta: "npm test" }],
      didSendViaMessagingTool: false,
      successfulCronAdds: 0,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
    });

    expect(artifacts).toMatchObject({
      finalStatus: "success",
      assistantTexts: ["done"],
      itemLifecycle: {
        startedCount: 2,
        completedCount: 2,
        activeCount: 0,
      },
    });
  });
});
