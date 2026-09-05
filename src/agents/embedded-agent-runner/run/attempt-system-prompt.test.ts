// Coverage for assembling provider-transformed embedded attempt system prompts.
import { prependSystemPromptAdditionAfterCacheBoundary } from "@openclaw/ai/internal/shared";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { buildBootstrapBudgetState } from "../../bootstrap-budget.js";
import type { AgentTool } from "../../runtime/index.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

// Prompt assembly consumes a prepared provider handle; discovery belongs to attempt setup.
vi.mock("../../../plugins/providers.runtime.js", () => {
  const rejectProviderDiscovery = () => {
    throw new Error("Prompt fixture unexpectedly discovered provider runtime");
  };
  return {
    isPluginProvidersLoadInFlight: rejectProviderDiscovery,
    resolvePluginProvidersCore: rejectProviderDiscovery,
  };
});

let buildAttemptSystemPrompt: typeof import("./attempt-system-prompt.js").buildAttemptSystemPrompt;
let prepareEmbeddedAttemptSystemPrompt: typeof import("./attempt-system-prompt-prepare.js").prepareEmbeddedAttemptSystemPrompt;
let providerRuntime: typeof import("../../../plugins/providers.runtime.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeAll(async () => {
  ({ buildAttemptSystemPrompt } = await import("./attempt-system-prompt.js"));
  ({ prepareEmbeddedAttemptSystemPrompt } = await import("./attempt-system-prompt-prepare.js"));
  providerRuntime = await import("../../../plugins/providers.runtime.js");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseProviderTransform = {
  provider: "openai",
  workspaceDir: "/tmp/openclaw",
  context: {
    provider: "openai",
    modelId: "gpt-5.5",
    promptMode: "full" as const,
  },
};

const transformProviderSystemPrompt: Parameters<
  typeof buildAttemptSystemPrompt
>[0]["transformProviderSystemPrompt"] = ({ context }) => context.systemPrompt;

async function preparePermissionPrompt(
  isRawModelRun = false,
  thinkLevel?: EmbeddedRunAttemptParams["thinkLevel"],
) {
  const tool = (name: string): AgentTool => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  });
  const read = tool("read");
  const write = tool("write");
  const exec = tool("exec");
  const tools = [read, write, exec];
  const attempt = {
    provider: "openai",
    modelId: "gpt-5.6-luna",
    model: makeProviderModelFixture({
      id: "gpt-5.6-luna",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    }),
    permissionMode: "full",
    promptMode: "full",
    sessionId: "permission-prompt",
    sessionKey: "agent:main:permission-prompt",
    workspaceDir: "/tmp/openclaw",
    config: {},
    thinkLevel,
  } as EmbeddedRunAttemptParams;
  const capabilityToolNames = new Set(tools.map(({ name }) => name));
  const prepared = await prepareEmbeddedAttemptSystemPrompt({
    attempt,
    activeContextEngine: undefined,
    bootstrap: {
      ...buildBootstrapBudgetState({ files: [] }),
      bootstrapMode: "full",
      contextFiles: [],
      bootstrapInjectionStats: [],
      shouldRecordCompletedBootstrapTurn: false,
      workspaceNotes: [],
    },
    capabilityToolNames,
    effectiveCwd: "/tmp/openclaw",
    effectiveTools: tools,
    effectiveWorkspace: "/tmp/openclaw",
    getProviderRuntimeHandle: () => ({ provider: attempt.provider, modelId: attempt.modelId }),
    isRawModelRun,
    markStage: vi.fn(),
    modelToolsEnabled: true,
    proactiveSubagentOrchestration: false,
    sandboxSessionKey: attempt.sessionKey!,
    sessionAgentId: "main",
    skillsPrompt: "",
    toolSearchDirectoryEnabled: false,
    toolSearchRuntimeConfig: attempt.config,
  });
  if (!prepared.preparePermissionPrompt) {
    throw new Error("Expected a refreshable attempt prompt");
  }
  return {
    attempt,
    capabilityToolNames,
    prepared,
    read,
    refreshSystemPrompt: async (prompt: string, refreshedTools: AgentTool[]) =>
      (await prepared.preparePermissionPrompt!(refreshedTools))(prompt),
    write,
  };
}

describe("buildAttemptSystemPrompt", () => {
  it("keeps model instructions identical when only reasoning effort changes", async () => {
    const prompts = [];
    for (const effort of ["low", "high", "medium"] as const) {
      prompts.push((await preparePermissionPrompt(false, effort)).prepared.systemPromptText);
    }
    expect(prompts[0]).not.toBe("");
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[2]).toBe(prompts[0]);
  });

  it.each([
    { sandboxSessionKey: "global", mode: "off", sandboxed: false },
    { sandboxSessionKey: "agent:main:policy", mode: "all", sandboxed: true },
  ])(
    "reports the selected sandbox policy for a global attempt ($sandboxSessionKey)",
    async (testCase) => {
      const providerDiscovery = vi.spyOn(providerRuntime, "resolvePluginProvidersCore");
      const workspaceDir = tempDirs.make("openclaw-global-system-prompt-");
      const config = {
        agents: {
          ownership: "explicit" as const,
          list: [
            { id: "main", sandbox: { mode: "all" as const } },
            { id: "marketing", sandbox: { mode: "off" as const } },
          ],
        },
      };
      const attempt = {
        config,
        agentId: "marketing",
        sessionId: "global-system-prompt",
        sessionKey: "global",
        provider: "openai",
        modelId: "gpt-5.5",
        model: { id: "gpt-5.5", provider: "openai", api: "openai-responses" },
        workspaceDir,
      };
      const result = await prepareEmbeddedAttemptSystemPrompt({
        attempt: attempt as never,
        bootstrap: {
          ...buildBootstrapBudgetState({ config, agentId: "marketing", files: [] }),
          workspaceNotes: [],
          contextFiles: [],
          bootstrapInjectionStats: [],
        } as never,
        activeContextEngine: undefined,
        capabilityToolNames: new Set(),
        effectiveCwd: workspaceDir,
        effectiveTools: [],
        effectiveWorkspace: workspaceDir,
        // Attempt setup binds even an absent provider plugin to the selected model.
        // Omitting that binding makes this policy test rediscover runtime plugins.
        getProviderRuntimeHandle: () => ({ provider: attempt.provider, modelId: attempt.modelId }),
        isRawModelRun: true,
        markStage: vi.fn(),
        modelToolsEnabled: false,
        proactiveSubagentOrchestration: false,
        sandboxSessionKey: testCase.sandboxSessionKey,
        sessionAgentId: "marketing",
        skillsPrompt: "",
        toolSearchDirectoryEnabled: false,
        toolSearchRuntimeConfig: config,
      });

      expect(result.systemPromptReport?.sandbox).toEqual({
        mode: testCase.mode,
        sandboxed: testCase.sandboxed,
      });
      expect(providerDiscovery).not.toHaveBeenCalled();
    },
  );
  it("replaces an intermediate permission prompt after later changes", async () => {
    const fixture = await preparePermissionPrompt();
    const { attempt, capabilityToolNames, prepared, read, refreshSystemPrompt, write } = fixture;
    const initialPrompt = prepared.systemPromptText;
    expect(initialPrompt).toContain("- exec:");
    expect(initialPrompt).toContain("exec approval-pending:");

    attempt.permissionMode = "workspace";
    capabilityToolNames.delete("exec");
    const currentTools = [read, write];
    const preparation = prepared.preparePermissionPrompt!(currentTools);
    expect(prepared.preparePermissionPrompt!(currentTools)).toBe(preparation);
    const intermediatePrompt = (await preparation)(initialPrompt);
    expect(intermediatePrompt).toContain("- write:");
    expect(intermediatePrompt).not.toContain("- exec:");

    attempt.permissionMode = "read-only";
    capabilityToolNames.delete("write");
    await refreshSystemPrompt(intermediatePrompt, [read]);
    // The delayed hook retained B while the live owner already advanced to C.
    const delayedHookPrompt = prependSystemPromptAdditionAfterCacheBoundary({
      systemPrompt: `Hook prefix\n\n${intermediatePrompt}\n\nHook suffix`,
      systemPromptAddition: "Current runtime addition",
    });
    const refreshed = await refreshSystemPrompt(delayedHookPrompt, [read]);
    expect(refreshed).toContain("- read:");
    expect(refreshed).not.toContain("- write:");
    expect(refreshed).not.toContain("- exec:");
    expect(refreshed).not.toContain("exec approval-pending:");
    expect(refreshed).toContain("Hook prefix");
    expect(refreshed).toContain("Hook suffix");
    expect(refreshed).toContain("Current runtime addition");
    expect(refreshed).toContain("permissions to read-only");
    expect(refreshed).not.toContain("permissions to workspace");
    expect(refreshed.match(/## Permission change/g)).toHaveLength(1);
    expect(await refreshSystemPrompt(refreshed, [read])).toBe(refreshed);
  });

  it("preserves explicit hook overrides while replacing their stale permission notice", async () => {
    const { attempt, read, refreshSystemPrompt } = await preparePermissionPrompt();
    attempt.permissionMode = "workspace";
    const overridden = await refreshSystemPrompt("Use the deliberate hook override.", [read]);
    attempt.permissionMode = "guarded";
    await refreshSystemPrompt(overridden, [read]);
    attempt.permissionMode = "read-only";
    const refreshed = await refreshSystemPrompt(overridden, [read]);

    expect(refreshed).toContain("Use the deliberate hook override.");
    expect(refreshed).not.toContain("## Tooling");
    expect(refreshed).toContain("permissions to read-only");
    expect(refreshed).not.toContain("permissions to workspace");
    expect(refreshed.match(/## Permission change/g)).toHaveLength(1);
  });

  it("does not inject permission guidance into raw model prompts", async () => {
    const { attempt, prepared, read, refreshSystemPrompt } = await preparePermissionPrompt(true);
    attempt.permissionMode = "read-only";
    expect(prepared.systemPromptText).toBe("");
    expect(await refreshSystemPrompt("", [read])).toBe("");
  });

  it("does not invoke ambient contributors during settled finalization", async () => {
    const getProviderRuntimeHandle = vi.fn();
    const markStage = vi.fn();
    const result = await prepareEmbeddedAttemptSystemPrompt({
      attempt: { operation: "settled-tool-finalization" },
      getProviderRuntimeHandle,
      markStage,
    } as never);

    expect(result.systemPromptText).toBe("");
    expect(result.runtimeChannel).toBeUndefined();
    expect(getProviderRuntimeHandle).not.toHaveBeenCalled();
    expect(markStage).toHaveBeenCalledWith("system-prompt");
  });

  it.each(["/tmp/openclaw", "/tmp/open\u202eclaw\n"])(
    "injects workspace identity context from %j",
    (workspaceDir) => {
      // Workspace identity files are part of the base system prompt and must
      // survive provider transformation.
      const result = buildAttemptSystemPrompt({
        isRawModelRun: false,
        transformProviderSystemPrompt,
        embeddedSystemPrompt: {
          workspaceDir,
          reasoningTagHint: false,
          runtimeInfo: {
            host: "test-host",
            os: "Darwin",
            arch: "arm64",
            node: "v22.0.0",
            model: "openai/gpt-5.5",
          },
          tools: [],
          modelAliasLines: [],
          userTimezone: "UTC",
          userDate: "2026-01-05",
          contextFiles: [
            { path: "/tmp/openclaw/SOUL.md", content: "SOUL_CONTEXT_MARKER" },
            { path: "/tmp/openclaw/IDENTITY.md", content: "IDENTITY_CONTEXT_MARKER" },
            { path: "/tmp/openclaw/USER.md", content: "USER_CONTEXT_MARKER" },
          ],
        },
        providerTransform: { ...baseProviderTransform, workspaceDir },
      });

      expect(result.systemPrompt).toContain("\nWorking directory: /tmp/openclaw\n");
      expect(result.systemPrompt).not.toContain("\u202e");
      expect(result.systemPrompt).toContain("# Project Context");
      expect(result.systemPrompt).toContain("## /tmp/openclaw/SOUL.md");
      expect(result.systemPrompt).toContain("SOUL_CONTEXT_MARKER");
      expect(result.systemPrompt).toContain("## /tmp/openclaw/IDENTITY.md");
      expect(result.systemPrompt).toContain("IDENTITY_CONTEXT_MARKER");
      expect(result.systemPrompt).toContain("## /tmp/openclaw/USER.md");
      expect(result.systemPrompt).toContain("USER_CONTEXT_MARKER");
    },
  );

  it("filters first-turn curated context to global and active-project entries", () => {
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        userDate: "2026-01-05",
        activeProjectKeys: ["github.com/acme/Alpha"],
        contextFiles: [
          {
            path: "/tmp/openclaw/MEMORY.md",
            content: [
              "# Durable memory",
              "- Alpha fact. <!-- project: github.com/acme/Alpha -->",
              "- Beta fact. <!-- project: github.com/acme/Beta -->",
              "- Global fact.",
            ].join("\n"),
          },
        ],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("Alpha fact");
    expect(result.systemPrompt).toContain("Global fact");
    expect(result.systemPrompt).not.toContain("Beta fact");
  });

  it("preserves bootstrap Project Context", () => {
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        userDate: "2026-01-05",
        bootstrapMode: "full",
        bootstrapTruncationNotice: "Bootstrap context was truncated.",
        contextFiles: [
          {
            path: "/tmp/openclaw/BOOTSTRAP.md",
            content: "Reply with BOOTSTRAP_OK.",
          },
          {
            path: "/tmp/openclaw/SOUL.md",
            content: "SOUL_CONTEXT_MARKER",
          },
          {
            path: "/tmp/openclaw/IDENTITY.md",
            content: "IDENTITY_CONTEXT_MARKER",
          },
          {
            path: "/tmp/openclaw/USER.md",
            content: "USER_CONTEXT_MARKER",
          },
        ],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("Current model identity: openai/gpt-5.5.");
    expect(result.systemPrompt).toContain("## Bootstrap Pending");
    expect(result.systemPrompt).toContain("BOOTSTRAP.md below; follow before normal reply.");
    expect(result.systemPrompt).toContain("## Bootstrap Context Notice");
    expect(result.systemPrompt).toContain("Bootstrap context was truncated.");
    expect(result.systemPrompt).toContain("# Project Context");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/SOUL.md");
    expect(result.systemPrompt).toContain("SOUL_CONTEXT_MARKER");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/IDENTITY.md");
    expect(result.systemPrompt).toContain("IDENTITY_CONTEXT_MARKER");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/USER.md");
    expect(result.systemPrompt).toContain("USER_CONTEXT_MARKER");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/BOOTSTRAP.md");
    expect(result.systemPrompt).toContain("Reply with BOOTSTRAP_OK.");
  });

  it("preserves runtime extra system prompt context", () => {
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        userDate: "2026-01-05",
        promptMode: "minimal",
        extraSystemPrompt:
          "# Subagent Context\n\n## Your Role\n- You were created to handle: RUN_MODE_TASK_77950",
        bootstrapMode: "full",
        contextFiles: [],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("Current model identity: openai/gpt-5.5.");
    expect(result.systemPrompt).toContain("## Subagent Context");
    expect(result.systemPrompt).toContain("RUN_MODE_TASK_77950");
  });

  it("omits system prompts for raw model probes", () => {
    // Raw model probes still build a base prompt for diagnostics, but the final
    // provider prompt must be empty.
    const result = buildAttemptSystemPrompt({
      isRawModelRun: true,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        userDate: "2026-01-05",
        bootstrapMode: "full",
        contextFiles: [
          {
            path: "/tmp/openclaw/BOOTSTRAP.md",
            content: "Reply with BOOTSTRAP_OK.",
          },
        ],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.baseSystemPrompt).toContain("BOOTSTRAP.md below; follow before normal reply.");
    expect(result.systemPrompt).toBe("");
  });
});
