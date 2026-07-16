/**
 * Broad coverage for createOpenClawCodingTools.
 * Verifies plugin tools, tool policy, schema cleanup, sandbox fs tools, and
 * assembled tool allowlist behavior.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  findUnsupportedSchemaKeywords,
  GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
} from "../plugin-sdk/provider-tools.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { isPluginToolAllowed } from "../plugins/tool-grant-allowlist.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { runWithAgentRingZeroTools } from "./agent-tools.ring-zero-context.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import * as openClawPluginTools from "./openclaw-plugin-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { expectReadWriteEditTools } from "./test-helpers/agent-tools-fs-helpers.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { stubTool } from "./test-helpers/fast-tool-stubs.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { buildEmptyExplicitToolAllowlistError } from "./tool-allowlist-guard.js";
import { DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY, normalizeToolName } from "./tool-policy.js";
import { replaceWithEffectiveCronCreatorToolAllowlist } from "./tools/cron-tool.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const tinyPngBuffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2f7z8AAAAASUVORK5CYII=",
  "base64",
);
const XAI_UNSUPPORTED_SCHEMA_KEYWORDS = new Set(["minContains", "maxContains"]);
function collectActionValues(schema: unknown, values: Set<string>): void {
  if (!schema || typeof schema !== "object") {
    return;
  }

  const record = schema as Record<string, unknown>;
  if (typeof record.const === "string") {
    values.add(record.const);
  }
  if (Array.isArray(record.enum)) {
    for (const value of record.enum) {
      if (typeof value === "string") {
        values.add(value);
      }
    }
  }
  if (Array.isArray(record.anyOf)) {
    for (const variant of record.anyOf) {
      collectActionValues(variant, values);
    }
  }
}

async function writeSessionStore(
  storeTemplate: string,
  agentId: string,
  entries: Record<string, unknown>,
) {
  const storePath = storeTemplate.replaceAll("{agentId}", agentId);
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ agentId, sessionKey, storePath }, entry as SessionEntry);
  }
}

function createToolsForStoredSession(storeTemplate: string, sessionKey: string) {
  return createOpenClawCodingTools({
    sessionKey,
    config: {
      session: {
        store: storeTemplate,
      },
      agents: {
        defaults: {
          subagents: {
            maxSpawnDepth: 2,
          },
        },
      },
    },
  });
}

function expectNoSubagentControlTools(tools: ReturnType<typeof createOpenClawCodingTools>) {
  const names = new Set(tools.map((tool) => tool.name));
  expect(names.has("sessions_spawn")).toBe(false);
  expect(names.has("sessions_list")).toBe(false);
  expect(names.has("sessions_history")).toBe(false);
  expect(names.has("subagents")).toBe(false);
}

function applyRuntimeToolsAllow<T extends { name: string }>(tools: T[], toolsAllow: string[]) {
  const allowSet = new Set(toolsAllow.map((name) => normalizeToolName(name)));
  return tools.filter((tool) => allowSet.has(normalizeToolName(tool.name)));
}

type OpenClawCodingTool = ReturnType<typeof createOpenClawCodingTools>[number];
type OpenClawToolsOptions = NonNullable<Parameters<typeof createOpenClawTools>[0]>;

function toolNameList(tools: readonly { name: string }[]): string[] {
  return tools.map((tool) => tool.name);
}

function requireTool(tools: OpenClawCodingTool[], name: string): OpenClawCodingTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`expected ${name} tool`);
  }
  return tool;
}

function requireToolExecute(tool: OpenClawCodingTool): NonNullable<OpenClawCodingTool["execute"]> {
  if (!tool.execute) {
    throw new Error(`expected ${tool.name} tool execute`);
  }
  return tool.execute;
}

function latestCreateOpenClawToolsOptions(): OpenClawToolsOptions {
  const calls = vi.mocked(createOpenClawTools).mock.calls;
  const lastCall = calls.at(-1);
  const options = lastCall?.[0];
  if (!options) {
    throw new Error("expected createOpenClawTools call");
  }
  return options;
}

function expectListIncludes(
  list: readonly string[] | undefined,
  expected: readonly string[],
): void {
  if (!list) {
    throw new Error("expected string list");
  }
  for (const value of expected) {
    expect(list.includes(value)).toBe(true);
  }
}

function cronCreatorToolNames(
  list: OpenClawToolsOptions["cronCreatorToolAllowlist"] | undefined,
): string[] | undefined {
  return list?.map((entry) => (typeof entry === "string" ? entry : entry.name));
}

describe("createOpenClawCodingTools", () => {
  it("reads node-hosted skill content through the assembled workspace-only read tool", async () => {
    const locator = "node://node-1/skills/pond/SKILL.md";
    const tools = createOpenClawCodingTools({
      config: { tools: { fs: { workspaceOnly: true } } },
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "pond" }],
        resolvedSkills: [
          {
            name: "pond",
            description: "Pond skill",
            filePath: locator,
            baseDir: "node://node-1/skills/pond",
            readContent: "# Pond\nassembled-marker",
            source: "openclaw-node",
            sourceInfo: {
              source: "openclaw-node",
              path: locator,
              scope: "temporary",
              origin: "top-level",
            },
            disableModelInvocation: false,
          },
        ],
      },
    });

    const result = await requireTool(tools, "read").execute("node-skill-read", {
      path: locator,
    });

    expect(JSON.stringify(result)).toContain("assembled-marker");
  });

  const testConfig: OpenClawConfig = {};

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("exposes only gateway config reads to owner sessions", () => {
    const tools = createOpenClawCodingTools({ config: testConfig });
    const gateway = requireTool(tools, "gateway");

    const parameters = gateway.parameters as {
      properties?: Record<string, unknown>;
    };
    const action = parameters.properties?.action as
      | { const?: unknown; enum?: unknown[] }
      | undefined;
    const values = new Set<string>();
    collectActionValues(action, values);

    expect([...values]).toEqual(["config.get", "config.schema.lookup"]);
  });

  it("does not add Tool Search control tools from the shared factory by default", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          toolSearch: true,
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("tool_search_code")).toBe(false);
    expect(names.has("tool_search")).toBe(false);
    expect(names.has("tool_describe")).toBe(false);
    expect(names.has("tool_call")).toBe(false);
  });

  it("passes explicit hook channel ids to wrapped tool hooks", async () => {
    const beforeToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hook-channel-"));
    await fs.writeFile(path.join(tmpDir, "note.txt"), "hello");
    const tools = createOpenClawCodingTools({
      workspaceDir: tmpDir,
      currentChannelId: "telegram:-100123",
      hookChannelId: "-100123",
    });
    const readTool = requireTool(tools, "read");
    await requireToolExecute(readTool)("tool-hook-channel", { path: "note.txt" });

    expect(beforeToolCall).toHaveBeenCalledTimes(1);
    expect(beforeToolCall.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ channelId: "-100123" }),
    );
  });

  it("re-wraps existing before_tool_call hooks once with the current context", async () => {
    const beforeToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const wrapped = wrapToolWithBeforeToolCallHook(
      {
        name: "already_wrapped",
        label: "Already wrapped",
        description: "Already wrapped tool",
        parameters: {},
        execute,
      },
      { agentId: "main", sessionId: "session-original" },
    );
    vi.mocked(createOpenClawTools).mockReturnValueOnce([wrapped as never]);

    const tools = createOpenClawCodingTools({ agentId: "main", sessionId: "session-new" });
    const tool = requireTool(tools, "already_wrapped");
    await requireToolExecute(tool)("call-wrapped", {});

    expect(beforeToolCall).toHaveBeenCalledTimes(1);
    expect(beforeToolCall.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ agentId: "main", sessionId: "session-new" }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(tool.parameters).toEqual({ type: "object", properties: {} });
  });

  it("adds Tool Search control tools when explicitly requested", () => {
    const tools = createOpenClawCodingTools({
      includeToolSearchControls: true,
      config: {
        tools: {
          toolSearch: true,
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("tool_search_code")).toBe(true);
    expect(names.has("tool_search")).toBe(true);
    expect(names.has("tool_describe")).toBe(true);
    expect(names.has("tool_call")).toBe(true);
  });

  it("keeps Tool Search controls available under restrictive tool profiles", () => {
    const tools = createOpenClawCodingTools({
      includeToolSearchControls: true,
      config: {
        tools: {
          profile: "coding",
          toolSearch: true,
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("tool_search_code")).toBe(true);
    expect(names.has("tool_search")).toBe(true);
    expect(names.has("tool_describe")).toBe(true);
    expect(names.has("tool_call")).toBe(true);
    expect(names.has("message")).toBe(false);
  });

  it("keeps Tool Search controls available under restrictive tool allowlists", () => {
    const tools = createOpenClawCodingTools({
      includeToolSearchControls: true,
      config: {
        tools: {
          allow: ["read"],
          toolSearch: true,
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("read")).toBe(true);
    expect(names.has("exec")).toBe(false);
    expect(names.has("tool_search_code")).toBe(true);
    expect(names.has("tool_search")).toBe(true);
    expect(names.has("tool_describe")).toBe(true);
    expect(names.has("tool_call")).toBe(true);
  });

  it("lets explicit deny policies remove Tool Search controls", () => {
    const tools = createOpenClawCodingTools({
      includeToolSearchControls: true,
      config: {
        tools: {
          profile: "coding",
          deny: ["tool_search_code"],
          toolSearch: true,
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("tool_search_code")).toBe(false);
    expect(names.has("read")).toBe(true);
  });

  it("keeps Tool Search controls when core OpenClaw tools are not materialized", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    const tools = createOpenClawCodingTools({
      includeCoreTools: false,
      includeToolSearchControls: true,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: true,
      },
      config: {
        tools: {
          toolSearch: true,
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(createOpenClawToolsMock).not.toHaveBeenCalled();
    expect(names.has("tool_search_code")).toBe(true);
    expect(names.has("tool_search")).toBe(true);
    expect(names.has("tool_describe")).toBe(true);
    expect(names.has("tool_call")).toBe(true);
    expect(names.has("message")).toBe(false);
    expect(names.has("exec")).toBe(false);
  });

  it("exposes control-plane tools to configured sessions", () => {
    const tools = createOpenClawCodingTools({
      config: testConfig,
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("cron")).toBe(true);
    expect(names.has("gateway")).toBe(true);
    expect(names.has("nodes")).toBe(true);
  });

  it("resolves isolated cron runtime toolsAllow", () => {
    const allowed = applyRuntimeToolsAllow(
      createOpenClawCodingTools({
        config: testConfig,
      }),
      ["cron"],
    );

    expect(allowed.map((tool) => tool.name)).toEqual(["cron"]);
    expect(
      buildEmptyExplicitToolAllowlistError({
        sources: [{ label: "runtime toolsAllow", entries: ["cron"] }],
        callableToolNames: allowed.map((tool) => tool.name),
        toolsEnabled: true,
      }),
    ).toBeNull();
  });

  it("keeps the injected ring-zero tool under policy and rejects a same-name replacement", () => {
    const injectedTool = {
      ...stubTool("openclaw"),
      label: "OpenClaw",
      description: "trusted ring-zero tool",
      execute: async () => ({ content: [], details: {} }),
    };
    const duplicateTool = {
      ...stubTool("openclaw"),
      label: "OpenClaw",
      description: "duplicate plugin tool",
      execute: async () => ({ content: [], details: {} }),
    };
    vi.mocked(createOpenClawTools).mockReturnValueOnce([duplicateTool]);

    const tools = runWithAgentRingZeroTools([injectedTool], () =>
      createOpenClawCodingTools({
        config: { tools: { allow: ["read"], deny: ["openclaw"] } },
        runtimeToolAllowlist: ["openclaw"],
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: true,
          includePluginTools: true,
        },
      }),
    );

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("openclaw");
    expect(tools[0]?.description).toBe("trusted ring-zero tool");
  });

  it("uses runtime toolsAllow when materializing plugin tools", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: testConfig,
      runtimeToolAllowlist: ["memory_search", "memory_get"],
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    const options = latestCreateOpenClawToolsOptions();
    expectListIncludes(options.pluginToolAllowlist, ["memory_search", "memory_get"]);
  });

  it("preserves runtime-allowed message through restrictive profiles", () => {
    const tools = createOpenClawCodingTools({
      config: { tools: { profile: "minimal" } },
      runtimeToolAllowlist: ["message"],
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });

    expect(toolNameList(tools)).toContain("message");
  });

  it("preserves runtime-allowed message through local model lean filtering", () => {
    const tools = createOpenClawCodingTools({
      config: {
        agents: {
          defaults: {
            experimental: {
              localModelLean: true,
            },
          },
        },
        tools: { profile: "minimal" },
      },
      runtimeToolAllowlist: ["message"],
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });

    expect(toolNameList(tools)).toContain("message");
  });

  it("preserves configured media tools through local model lean filtering", () => {
    const tools = createOpenClawCodingTools({
      config: {
        agents: {
          defaults: {
            experimental: {
              localModelLean: true,
            },
          },
          list: [
            {
              id: "artist",
              tools: {
                alsoAllow: ["video_generate"],
                byProvider: {
                  ollama: {
                    alsoAllow: ["tts"],
                  },
                },
              },
            },
          ],
        },
        tools: {
          alsoAllow: ["pdf"],
          byProvider: {
            "ollama/qwen3.5:9b": {
              alsoAllow: ["image_generate"],
            },
          },
        },
      },
      agentId: "artist",
      modelProvider: "ollama",
      modelId: "qwen3.5:9b",
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });

    expect(toolNameList(tools)).toEqual(
      expect.arrayContaining(["image_generate", "pdf", "tts", "video_generate"]),
    );
  });

  it("does not treat built-in profile tools as lean-mode overrides", () => {
    const tools = createOpenClawCodingTools({
      config: {
        agents: {
          defaults: {
            experimental: {
              localModelLean: true,
            },
          },
        },
        tools: {
          profile: "coding",
        },
      },
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });

    expect(toolNameList(tools)).not.toEqual(
      expect.arrayContaining(["image_generate", "video_generate"]),
    );
  });

  it("preserves forced message through local model lean filtering without runtime allowlist", () => {
    const tools = createOpenClawCodingTools({
      config: {
        agents: {
          defaults: {
            experimental: {
              localModelLean: true,
            },
          },
        },
        tools: { profile: "minimal" },
      },
      forceMessageTool: true,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });

    expect(toolNameList(tools)).toContain("message");
  });

  it("preserves message-tool-only replies through local model lean filtering without runtime allowlist", () => {
    const tools = createOpenClawCodingTools({
      config: {
        agents: {
          defaults: {
            experimental: {
              localModelLean: true,
            },
          },
        },
        tools: { profile: "minimal" },
      },
      sourceReplyDeliveryMode: "message_tool_only",
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });

    expect(toolNameList(tools)).toContain("message");
  });

  it("preserves runtime allowlist groups containing message through restrictive profiles", () => {
    for (const runtimeToolAllowlist of [["group:messaging"], ["group:openclaw"], ["*"]]) {
      const tools = createOpenClawCodingTools({
        config: { tools: { profile: "minimal" } },
        runtimeToolAllowlist,
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: true,
          includePluginTools: false,
        },
      });

      expect(toolNameList(tools)).toContain("message");
    }
  });

  it("passes source reply delivery mode to OpenClaw tool construction", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: testConfig,
      forceMessageTool: true,
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    expect(latestCreateOpenClawToolsOptions().sourceReplyDeliveryMode).toBe("message_tool_only");
  });

  it("passes configured filesystem policy to OpenClaw tool construction", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: { tools: { fs: { workspaceOnly: true } } },
    });

    expect(latestCreateOpenClawToolsOptions().fsPolicy).toEqual({ workspaceOnly: true });
  });

  it("uses the canonical spawn workspace for follow-up task suggestions", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();
    const sandboxDir = "/sandbox/workspace";

    createOpenClawCodingTools({
      sandbox: createAgentToolsSandboxContext({
        workspaceDir: sandboxDir,
        workspaceAccess: "ro",
        fsBridge: createHostSandboxFsBridge(sandboxDir),
      }),
      workspaceDir: "/agent/workspace",
      cwd: sandboxDir,
      spawnWorkspaceDir: "/host/project",
    });

    expect(latestCreateOpenClawToolsOptions()).toMatchObject({
      workspaceDir: "/agent/workspace",
      spawnWorkspaceDir: "/host/project",
      cwd: "/host/project",
    });
  });

  it("keeps an unsandboxed task repo as the follow-up suggestion cwd", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      workspaceDir: "/agent/workspace",
      cwd: "/task/repo",
      spawnWorkspaceDir: "/agent/workspace",
    });

    expect(latestCreateOpenClawToolsOptions().cwd).toBe("/task/repo");
  });

  it("skips unrelated tool families when construction is planned from a narrow allowlist", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    const tools = createOpenClawCodingTools({
      config: testConfig,
      toolConstructionPlan: {
        includeBaseCodingTools: true,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(createOpenClawToolsMock).not.toHaveBeenCalled();
    expect(names.has("read")).toBe(true);
    expect(names.has("write")).toBe(true);
    expect(names.has("edit")).toBe(true);
    expect(names.has("exec")).toBe(false);
    expect(names.has("process")).toBe(false);
    expect(names.has("apply_patch")).toBe(false);
    expect(names.has("message")).toBe(false);
  });

  it("passes plugin suppression into OpenClaw tool construction plans", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: testConfig,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    expect(latestCreateOpenClawToolsOptions().disablePluginTools).toBe(true);
  });

  it("keeps plugin-only construction off the OpenClaw core factory", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: testConfig,
      includeCoreTools: false,
      runtimeToolAllowlist: ["memory_search"],
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: true,
      },
    });

    expect(createOpenClawToolsMock).not.toHaveBeenCalled();
  });

  it("forwards prepared run facts to plugin-only tool construction", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();
    const resolvePluginToolsSpy = vi
      .spyOn(openClawPluginTools, "resolveOpenClawPluginToolsForOptions")
      .mockReturnValue([]);

    try {
      createOpenClawCodingTools({
        config: testConfig,
        includeCoreTools: false,
        runtimeToolAllowlist: ["memory_search"],
        modelProvider: "openrouter",
        modelId: "openrouter/auto",
        nativeChannelId: "oc_native_chat",
        clientCaps: ["inline-widgets"],
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: true,
        },
      });

      expect(createOpenClawToolsMock).not.toHaveBeenCalled();
      expect(resolvePluginToolsSpy).toHaveBeenCalledTimes(1);
      const pluginToolOptions = resolvePluginToolsSpy.mock.calls[0]?.[0].options;
      expect(pluginToolOptions?.modelProvider).toBe("openrouter");
      expect(pluginToolOptions?.modelId).toBe("openrouter/auto");
      expect(pluginToolOptions?.nativeChannelId).toBe("oc_native_chat");
      expect(pluginToolOptions?.clientCaps).toEqual(["inline-widgets"]);
    } finally {
      resolvePluginToolsSpy.mockRestore();
    }
  });

  it("wraps plugin-only tools with trusted caller routing context", async () => {
    let observedIdentity: unknown;
    const resolvePluginToolsSpy = vi
      .spyOn(openClawPluginTools, "resolveOpenClawPluginToolsForOptions")
      .mockReturnValue([
        {
          name: "file_fetch",
          label: "File fetch",
          description: "Fetch a file",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            observedIdentity = getGatewayToolCallerIdentity();
            return { content: [{ type: "text" as const, text: "ok" }], details: {} };
          },
        },
      ]);

    try {
      const tools = createOpenClawCodingTools({
        config: testConfig,
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:alice",
        messageProvider: "discord-voice",
        messageChannel: "discord",
        messageTo: "channel:123",
        agentAccountId: "work",
        messageThreadId: "42",
        includeCoreTools: false,
        runtimeToolAllowlist: ["file_fetch"],
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: true,
        },
      });

      await requireTool(tools, "file_fetch").execute?.("tool-call-1", {});
      expect(observedIdentity).toEqual({
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:alice",
        turnSourceChannel: "discord",
        turnSourceTo: "channel:123",
        turnSourceAccountId: "work",
        turnSourceThreadId: "42",
      });
    } finally {
      resolvePluginToolsSpy.mockRestore();
    }
  });

  it("forwards owner identity to plugin-only tool construction", () => {
    const resolvePluginToolsSpy = vi
      .spyOn(openClawPluginTools, "resolveOpenClawPluginToolsForOptions")
      .mockReturnValue([]);

    try {
      createOpenClawCodingTools({
        config: testConfig,
        includeCoreTools: false,
        runtimeToolAllowlist: ["codex_threads"],
        senderIsOwner: true,
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: true,
        },
      });

      expect(resolvePluginToolsSpy).toHaveBeenCalledTimes(1);
      expect(resolvePluginToolsSpy.mock.calls[0]?.[0].options?.senderIsOwner).toBe(true);
    } finally {
      resolvePluginToolsSpy.mockRestore();
    }
  });

  it("forwards the native channel id through standard tool construction", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: testConfig,
      chatType: "group",
      nativeChannelId: "oc_native_chat",
      messageActionTurnCapability: "turn-capability-1",
    });

    expect(latestCreateOpenClawToolsOptions().nativeChannelId).toBe("oc_native_chat");
    expect(latestCreateOpenClawToolsOptions().currentChatType).toBe("group");
    expect(latestCreateOpenClawToolsOptions().messageActionTurnCapability).toBe(
      "turn-capability-1",
    );
  });

  it("forwards auth profiles to plugin-only tool construction", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();
    const resolvePluginToolsSpy = vi
      .spyOn(openClawPluginTools, "resolveOpenClawPluginToolsForOptions")
      .mockReturnValue([]);
    const authProfileStore = {
      version: 1,
      order: { xai: ["xai-oauth"] },
      profiles: {
        "xai-oauth": {
          type: "oauth",
          provider: "xai",
          access: "xai-oauth-access-token", // pragma: allowlist secret
          refresh: "xai-oauth-refresh-token", // pragma: allowlist secret
          expires: Date.now() + 60_000,
        },
      },
    } satisfies AuthProfileStore;

    try {
      createOpenClawCodingTools({
        config: {
          auth: {
            order: {
              xai: ["xai-oauth"],
            },
          },
        },
        authProfileStore,
        includeCoreTools: false,
        runtimeToolAllowlist: ["x_search"],
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: true,
        },
      });

      expect(createOpenClawToolsMock).not.toHaveBeenCalled();
      expect(resolvePluginToolsSpy).toHaveBeenCalledTimes(1);
      const pluginToolOptions = resolvePluginToolsSpy.mock.calls[0]?.[0].options;
      expect(pluginToolOptions?.authProfileStore).toBe(authProfileStore);
    } finally {
      resolvePluginToolsSpy.mockRestore();
    }
  });

  it("uses tools.alsoAllow for optional plugin discovery without widening to all plugins", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: { tools: { alsoAllow: ["lobster"] } },
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    expect(latestCreateOpenClawToolsOptions().pluginToolAllowlist).toStrictEqual([
      "lobster",
      DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
    ]);
  });

  it("materializes additive runtime tools while preserving normal deny policy", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();
    const config: OpenClawConfig = {
      tools: {
        profile: "coding",
        deny: ["workboard_block"],
      },
    };

    createOpenClawCodingTools({
      config,
      conversationCapabilityProfile: resolveConversationCapabilityProfile({
        config,
        runtimePluginToolGrant: {
          pluginId: "workboard",
          toolNames: ["workboard_heartbeat", "workboard_complete"],
        },
      }),
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    expect(latestCreateOpenClawToolsOptions().pluginToolAllowlist).not.toContain(
      "workboard_heartbeat",
    );
    expect(
      isPluginToolAllowed(
        new Set(latestCreateOpenClawToolsOptions().pluginToolAllowlist),
        "workboard",
        "workboard_heartbeat",
      ),
    ).toBe(true);
    expect(latestCreateOpenClawToolsOptions()).not.toHaveProperty("runtimePluginToolGrant");
    expectListIncludes(latestCreateOpenClawToolsOptions().pluginToolDenylist, ["workboard_block"]);
  });

  it("passes explicit denylist entries to OpenClaw tool factory planning", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: { tools: { deny: ["pdf"] } },
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    expectListIncludes(latestCreateOpenClawToolsOptions().pluginToolDenylist, ["pdf"]);
  });

  it("passes inherited allowlist entries to OpenClaw plugin discovery", async () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();
    const agentId = `inherited-allow-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const storeTemplate = path.join(
      os.tmpdir(),
      `openclaw-session-store-${agentId}-{agentId}.json`,
    );
    await writeSessionStore(storeTemplate, agentId, {
      [`agent:${agentId}:subagent:limited`]: {
        sessionId: "limited-session",
        updatedAt: Date.now(),
        spawnDepth: 1,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        inheritedToolAllow: ["custom_plugin_tool", "sessions_spawn"],
      },
    });

    createOpenClawCodingTools({
      sessionKey: `agent:${agentId}:subagent:limited`,
      config: {
        session: {
          store: storeTemplate,
        },
      },
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    expectListIncludes(latestCreateOpenClawToolsOptions().pluginToolAllowlist, [
      "custom_plugin_tool",
      "sessions_spawn",
    ]);
  });

  it("passes effective allow-list-restricted tool surface to spawned sessions", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: { tools: { allow: ["read", "sessions_spawn"] } },
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    const inheritedAllow = latestCreateOpenClawToolsOptions().inheritedToolAllowlist;
    expectListIncludes(inheritedAllow, ["read", "sessions_spawn"]);
    expect(inheritedAllow?.includes("exec")).toBe(false);
    expect(inheritedAllow?.includes("process")).toBe(false);
  });

  it("passes group-restricted tool surface to cron-created agent turns", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      sessionKey: "agent:main:whatsapp:group:restricted-room",
      config: {
        tools: { allow: ["read", "exec", "process", "cron"] },
        channels: {
          whatsapp: {
            groups: {
              "restricted-room": {
                tools: { allow: ["read", "cron"] },
              },
            },
          },
        },
      },
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    const cronAllow = latestCreateOpenClawToolsOptions().cronCreatorToolAllowlist;
    const cronAllowNames = cronCreatorToolNames(cronAllow);
    expectListIncludes(cronAllowNames, ["read", "cron"]);
    expect(cronAllowNames?.includes("exec")).toBe(false);
    expect(cronAllowNames?.includes("process")).toBe(false);
  });

  it("lets embedded attempts refresh a caller-owned cron creator tool surface", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();
    const cronCreatorToolAllowlistRef: NonNullable<
      OpenClawToolsOptions["cronCreatorToolAllowlist"]
    > = [];

    createOpenClawCodingTools({
      config: { tools: { allow: ["read", "cron"] } },
      cronCreatorToolAllowlistRef,
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    const cronAllow = latestCreateOpenClawToolsOptions().cronCreatorToolAllowlist;
    expect(cronAllow).toBe(cronCreatorToolAllowlistRef);
    expect(cronCreatorToolNames(cronAllow)).toEqual(["read", "cron"]);

    replaceWithEffectiveCronCreatorToolAllowlist(cronCreatorToolAllowlistRef, [
      stubTool("read"),
      stubTool("cron"),
      stubTool("bundle_mcp_search"),
    ]);

    expect(cronCreatorToolNames(cronAllow)).toEqual(["read", "cron", "bundle_mcp_search"]);
  });

  it("passes deny-restricted tool surface to cron-created agent turns", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      sessionKey: "agent:main:whatsapp:group:restricted-room",
      config: {
        tools: { allow: ["read", "exec", "process", "cron"] },
        channels: {
          whatsapp: {
            groups: {
              "restricted-room": {
                tools: { deny: ["exec", "process"] },
              },
            },
          },
        },
      },
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    const cronAllow = latestCreateOpenClawToolsOptions().cronCreatorToolAllowlist;
    const cronAllowNames = cronCreatorToolNames(cronAllow);
    expectListIncludes(cronAllowNames, ["read", "cron"]);
    expect(cronAllowNames?.includes("exec")).toBe(false);
    expect(cronAllowNames?.includes("process")).toBe(false);
  });

  it("records core tool-prep stages for hot-path diagnostics", () => {
    const stages: string[] = [];

    createOpenClawCodingTools({
      config: testConfig,
      recordToolPrepStage: (name) => stages.push(name),
    });

    expectListIncludes(stages, [
      "tool-policy",
      "workspace-policy",
      "base-coding-tools",
      "shell-tools",
      "openclaw-tools:test-helper",
      "openclaw-tools",
      "message-provider-policy",
      "model-provider-policy",
      "authorization-policy",
      "schema-normalization",
      "tool-hooks",
      "abort-wrappers",
      "deferred-followup-descriptions",
    ]);
    expect(stages.indexOf("tool-policy")).toBeLessThan(stages.indexOf("workspace-policy"));
    expect(stages.indexOf("workspace-policy")).toBeLessThan(stages.indexOf("base-coding-tools"));
    expect(stages.indexOf("openclaw-tools:test-helper")).toBeLessThan(
      stages.indexOf("openclaw-tools"),
    );
    expect(stages.indexOf("schema-normalization")).toBeLessThan(stages.indexOf("tool-hooks"));
  });

  it("preserves action enums in normalized schemas", () => {
    const defaultTools = createOpenClawCodingTools({ config: testConfig });
    const toolNames = ["canvas", "nodes", "cron", "gateway", "message"];
    const missingNames = toolNames.filter(
      (name) => !defaultTools.some((candidate) => candidate.name === name),
    );
    expect(missingNames).toStrictEqual([]);

    for (const name of toolNames) {
      const tool = defaultTools.find((candidate) => candidate.name === name);
      const parameters = tool?.parameters as {
        properties?: Record<string, unknown>;
      };
      const action = parameters.properties?.action as
        | { const?: unknown; enum?: unknown[] }
        | undefined;
      const values = new Set<string>();
      collectActionValues(action, values);

      const min = name === "gateway" ? 1 : 2;
      expect(values.size).toBeGreaterThanOrEqual(min);
    }
  });

  it("enforces apply_patch availability and canonical names across model/provider constraints", () => {
    const defaultTools = createOpenClawCodingTools({ config: testConfig });
    expect(toolNameList(defaultTools)).toContain("exec");
    expect(toolNameList(defaultTools)).toContain("process");
    expect(toolNameList(defaultTools)).toContain("apply_patch");

    const openAiTools = createOpenClawCodingTools({
      config: testConfig,
      modelProvider: "openai",
      modelId: "gpt-5.4",
    });
    expect(toolNameList(openAiTools)).toContain("apply_patch");

    const codexTools = createOpenClawCodingTools({
      config: testConfig,
      modelProvider: "openai",
      modelId: "gpt-5.4",
    });
    expect(toolNameList(codexTools)).toContain("apply_patch");

    const disabledConfig: OpenClawConfig = {
      tools: {
        exec: {
          applyPatch: { enabled: false },
        },
      },
    };
    const disabledOpenAiTools = createOpenClawCodingTools({
      config: disabledConfig,
      modelProvider: "openai",
      modelId: "gpt-5.4",
    });
    expect(toolNameList(disabledOpenAiTools)).not.toContain("apply_patch");

    const anthropicTools = createOpenClawCodingTools({
      config: disabledConfig,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-6",
    });
    expect(toolNameList(anthropicTools)).not.toContain("apply_patch");

    const allowModelsConfig: OpenClawConfig = {
      tools: {
        exec: {
          applyPatch: { allowModels: ["gpt-5.4"] },
        },
      },
    };
    const allowed = createOpenClawCodingTools({
      config: allowModelsConfig,
      modelProvider: "openai",
      modelId: "gpt-5.4",
    });
    expect(toolNameList(allowed)).toContain("apply_patch");

    const denied = createOpenClawCodingTools({
      config: allowModelsConfig,
      modelProvider: "openai",
      modelId: "gpt-5.4-mini",
    });
    expect(toolNameList(denied)).not.toContain("apply_patch");

    const oauthTools = createOpenClawCodingTools({
      config: testConfig,
      modelProvider: "anthropic",
      modelAuthMode: "oauth",
    });
    const names = new Set(oauthTools.map((tool) => tool.name));
    expect(names.has("exec")).toBe(true);
    expect(names.has("read")).toBe(true);
    expect(names.has("write")).toBe(true);
    expect(names.has("edit")).toBe(true);
    expect(names.has("apply_patch")).toBe(true);
  });

  it("provides top-level object schemas for all tools", () => {
    const tools = createOpenClawCodingTools({ config: testConfig });
    const offenders = tools
      .map((tool) => {
        const schema =
          tool.parameters && typeof tool.parameters === "object"
            ? (tool.parameters as Record<string, unknown>)
            : null;
        return {
          name: tool.name,
          type: schema?.type,
          keys: schema ? Object.keys(schema).toSorted() : null,
        };
      })
      .filter((entry) => entry.type !== "object");

    expect(offenders).toStrictEqual([]);
  });

  it("does not expose provider-specific message tools", () => {
    const tools = createOpenClawCodingTools({ messageProvider: "discord" });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("discord")).toBe(false);
    expect(names.has("slack")).toBe(false);
    expect(names.has("telegram")).toBe(false);
    expect(names.has("whatsapp")).toBe(false);
  });

  it("separates the canonical message provider from transport tool policy", () => {
    vi.mocked(createOpenClawTools).mockClear();

    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          toolsBySender: {
            "channel:discord:speaker-1": { deny: ["exec"] },
          },
        },
      },
      messageProvider: "discord",
      toolPolicyMessageProvider: "discord-voice",
      senderId: "speaker-1",
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("exec")).toBe(false);
    expect(names.has("tts")).toBe(false);
    expect(latestCreateOpenClawToolsOptions().agentChannel).toBe("discord");
  });

  it("filters session tools for sub-agent sessions by default", () => {
    const tools = createOpenClawCodingTools({
      sessionKey: "agent:main:subagent:test",
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("sessions_list")).toBe(false);
    expect(names.has("sessions_history")).toBe(false);
    expect(names.has("sessions_send")).toBe(false);
    expect(names.has("sessions_spawn")).toBe(false);
    expect(names.has("subagents")).toBe(false);

    expect(names.has("read")).toBe(true);
    expect(names.has("exec")).toBe(true);
    expect(names.has("process")).toBe(true);
    expect(names.has("apply_patch")).toBe(true);
  });

  it("uses stored spawnDepth to apply leaf tool policy for flat depth-2 session keys", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-depth-policy-"));
    try {
      const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
      await writeSessionStore(storeTemplate, "main", {
        "agent:main:subagent:flat": {
          sessionId: "session-flat-depth-2",
          updatedAt: Date.now(),
          spawnDepth: 2,
        },
      });

      const tools = createToolsForStoredSession(storeTemplate, "agent:main:subagent:flat");
      expectNoSubagentControlTools(tools);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("applies subagent tool policy to ACP children spawned under a subagent envelope", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-subagent-policy-"));
    try {
      const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
      await writeSessionStore(storeTemplate, "main", {
        "agent:main:acp:child": {
          sessionId: "session-acp-child",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:subagent:parent",
          spawnDepth: 2,
          subagentRole: "leaf",
          subagentControlScope: "none",
        },
        "agent:main:acp:plain": {
          sessionId: "session-acp-plain",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:main",
        },
        "agent:main:acp:parent": {
          sessionId: "session-acp-parent",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:subagent:parent",
        },
      });
      await writeSessionStore(storeTemplate, "writer", {
        "agent:writer:acp:child": {
          sessionId: "session-acp-cross-agent-child",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:acp:parent",
        },
      });

      const persistedEnvelopeTools = createToolsForStoredSession(
        storeTemplate,
        "agent:main:acp:child",
      );
      expectNoSubagentControlTools(persistedEnvelopeTools);

      const restrictedTools = createToolsForStoredSession(storeTemplate, "agent:main:acp:plain");
      const restrictedNames = new Set(restrictedTools.map((tool) => tool.name));
      expect(restrictedNames.has("sessions_spawn")).toBe(true);
      expect(restrictedNames.has("subagents")).toBe(true);

      const ancestryTools = createToolsForStoredSession(storeTemplate, "agent:writer:acp:child");
      expectNoSubagentControlTools(ancestryTools);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("applies leaf tool policy for cross-agent subagent sessions when spawnDepth is missing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cross-agent-subagent-"));
    try {
      const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
      await writeSessionStore(storeTemplate, "main", {
        "agent:main:subagent:parent": {
          sessionId: "session-main-parent",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:main",
        },
      });
      await writeSessionStore(storeTemplate, "writer", {
        "agent:writer:subagent:child": {
          sessionId: "session-writer-child",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:subagent:parent",
        },
      });

      const tools = createToolsForStoredSession(storeTemplate, "agent:writer:subagent:child");
      expectNoSubagentControlTools(tools);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports allow-only sub-agent tool policy", () => {
    const tools = createOpenClawCodingTools({
      sessionKey: "agent:main:subagent:test",
      config: {
        tools: {
          subagents: {
            tools: {
              allow: ["read"],
            },
          },
        },
      },
    });
    expect(tools.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("applies tool profiles before allow/deny policies", () => {
    const tools = createOpenClawCodingTools({
      config: { tools: { profile: "messaging" } },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("message")).toBe(true);
    expect(names.has("sessions_send")).toBe(true);
    expect(names.has("sessions_spawn")).toBe(false);
    expect(names.has("exec")).toBe(false);
    expect(names.has("browser")).toBe(false);
  });

  it("includes browser tool with full profile when browser is configured (#76507)", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "full" },
        browser: { enabled: true },
        plugins: { entries: { browser: { enabled: true } } },
      } as OpenClawConfig,
    });
    const names = new Set(tools.map((tool) => tool.name));
    // full profile must not filter any tools — browser, canvas, etc. must be present.
    expect(names.has("browser")).toBe(true);
    expect(names.has("canvas")).toBe(true);
    expect(names.has("exec")).toBe(true);
    expect(names.has("message")).toBe(true);
  });

  it("includes browser tool with full profile (#76507)", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "full" },
        browser: { enabled: true },
        plugins: { entries: { browser: { enabled: true } } },
      } as OpenClawConfig,
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("browser")).toBe(true);
    expect(names.has("canvas")).toBe(true);
    expect(names.has("gateway")).toBe(true);
    expect(names.has("cron")).toBe(true);
    expect(names.has("nodes")).toBe(true);
  });

  it("includes browser tool without explicit profile (defaults to no filtering) (#76507)", () => {
    const tools = createOpenClawCodingTools({
      config: {
        browser: { enabled: true },
        plugins: { entries: { browser: { enabled: true } } },
      } as OpenClawConfig,
    });
    const names = new Set(tools.map((tool) => tool.name));
    // No profile means no profile filtering — all tools pass.
    expect(names.has("browser")).toBe(true);
  });

  it("keeps browser out of coding-profile subagents unless profile-stage alsoAllow adds it", () => {
    const baseConfig = {
      browser: { enabled: true },
      plugins: { entries: { browser: { enabled: true } } },
      tools: { profile: "coding" },
    } as OpenClawConfig;
    const codingSubagent = createOpenClawCodingTools({
      sessionKey: "agent:main:subagent:test",
      config: baseConfig,
    });
    const codingNames = new Set(codingSubagent.map((tool) => tool.name));
    expect(codingNames.has("browser")).toBe(false);

    const subagentAllowOnly = createOpenClawCodingTools({
      sessionKey: "agent:main:subagent:test",
      config: {
        ...baseConfig,
        tools: {
          profile: "coding",
          subagents: { tools: { allow: ["browser"] } },
        },
      } as OpenClawConfig,
    });
    expect(toolNameList(subagentAllowOnly)).not.toContain("browser");

    const profileStageAlsoAllow = createOpenClawCodingTools({
      sessionKey: "agent:main:subagent:test",
      config: {
        ...baseConfig,
        tools: { profile: "coding", alsoAllow: ["browser"] },
      } as OpenClawConfig,
    });
    expect(toolNameList(profileStageAlsoAllow)).toContain("browser");
  });

  it("can keep message available when a cron route needs it under the coding profile", () => {
    const codingTools = createOpenClawCodingTools({
      config: { tools: { profile: "coding" } },
    });
    expect(toolNameList(codingTools)).not.toContain("message");

    const cronTools = createOpenClawCodingTools({
      config: { tools: { profile: "coding" } },
      forceMessageTool: true,
    });
    expect(toolNameList(cronTools)).toContain("message");
  });

  it("keeps message available for message-tool-only source replies under the coding profile", () => {
    const tools = createOpenClawCodingTools({
      config: { tools: { profile: "coding" } },
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(toolNameList(tools)).toContain("message");
  });

  it("keeps heartbeat response available for heartbeat runs under the coding profile", () => {
    const codingTools = createOpenClawCodingTools({
      config: { tools: { profile: "coding" } },
      trigger: "heartbeat",
      enableHeartbeatTool: true,
      forceHeartbeatTool: true,
    });

    expect(toolNameList(codingTools)).toContain("heartbeat_respond");
  });

  it("enables heartbeat response when visible replies are message-tool-only", () => {
    const tools = createOpenClawCodingTools({
      config: {
        messages: { visibleReplies: "message_tool" },
        tools: { profile: "coding" },
      } as OpenClawConfig,
      trigger: "heartbeat",
    });

    expect(toolNameList(tools)).toContain("heartbeat_respond");
  });

  it("keeps skill_workshop available under the coding profile", () => {
    const tools = createOpenClawCodingTools({
      config: { tools: { profile: "coding" } },
    });

    expect(toolNameList(tools)).toContain("skill_workshop");
  });

  it("can keep message available when a cron route needs it under a provider coding profile", () => {
    const providerProfileTools = createOpenClawCodingTools({
      config: { tools: { byProvider: { openai: { profile: "coding" } } } },
      modelProvider: "openai",
      modelId: "gpt-5.4",
    });
    expect(toolNameList(providerProfileTools)).not.toContain("message");

    const cronTools = createOpenClawCodingTools({
      config: { tools: { byProvider: { openai: { profile: "coding" } } } },
      modelProvider: "openai",
      modelId: "gpt-5.4",
      forceMessageTool: true,
    });
    expect(toolNameList(cronTools)).toContain("message");
  });

  it("expands group shorthands in global tool policy", () => {
    const tools = createOpenClawCodingTools({
      config: { tools: { allow: ["group:fs"] } },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("read")).toBe(true);
    expect(names.has("write")).toBe(true);
    expect(names.has("edit")).toBe(true);
    expect(names.has("exec")).toBe(false);
    expect(names.has("browser")).toBe(false);
  });

  it("expands group shorthands in global tool deny policy", () => {
    const tools = createOpenClawCodingTools({
      config: { tools: { deny: ["group:fs"] } },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("read")).toBe(false);
    expect(names.has("write")).toBe(false);
    expect(names.has("edit")).toBe(false);
    expect(names.has("exec")).toBe(true);
  });

  it("lets agent profiles override global profiles", () => {
    const tools = createOpenClawCodingTools({
      sessionKey: "agent:work:main",
      config: {
        tools: { profile: "coding" },
        agents: {
          list: [{ id: "work", tools: { profile: "messaging" } }],
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("message")).toBe(true);
    expect(names.has("exec")).toBe(false);
    expect(names.has("read")).toBe(false);
  });

  it("removes unsupported JSON Schema keywords for Cloud Code Assist API compatibility", () => {
    const googleTools = createOpenClawCodingTools({
      modelProvider: "google",
    });
    for (const tool of googleTools) {
      const violations = findUnsupportedSchemaKeywords(
        tool.parameters,
        `${tool.name}.parameters`,
        GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
      );
      expect(violations).toStrictEqual([]);
    }
  });

  it("applies xai model compat for direct Grok tool cleanup", () => {
    const xaiTools = createOpenClawCodingTools({
      modelProvider: "xai",
      modelCompat: {
        toolSchemaProfile: "xai",
        unsupportedToolSchemaKeywords: Array.from(XAI_UNSUPPORTED_SCHEMA_KEYWORDS),
        nativeWebSearchTool: true,
        toolCallArgumentsEncoding: "html-entities",
      },
    });

    expect(toolNameList(xaiTools)).not.toContain("web_search");
    for (const tool of xaiTools) {
      const violations = findUnsupportedSchemaKeywords(
        tool.parameters,
        `${tool.name}.parameters`,
        XAI_UNSUPPORTED_SCHEMA_KEYWORDS,
      );
      expect(violations).toStrictEqual([]);
    }
  });

  it("returns image-aware read metadata for images and text-only blocks for text files", async () => {
    const defaultTools = createOpenClawCodingTools();
    const readTool = requireTool(defaultTools, "read");
    const readExecute = requireToolExecute(readTool);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-"));
    try {
      const imagePath = path.join(tmpDir, "sample.png");
      await fs.writeFile(imagePath, tinyPngBuffer);

      const imageResult = await readExecute("tool-1", {
        path: imagePath,
      });

      const imageBlocks = imageResult?.content?.filter((block) => block.type === "image") as
        | Array<{ mimeType?: string }>
        | undefined;
      const imageTextBlocks = imageResult?.content?.filter((block) => block.type === "text") as
        | Array<{ text?: string }>
        | undefined;
      const imageText = imageTextBlocks?.map((block) => block.text ?? "").join("\n") ?? "";
      expect(imageText).toContain("Read image file [image/png]");
      if ((imageBlocks?.length ?? 0) > 0) {
        expect(imageBlocks?.every((block) => block.mimeType === "image/png")).toBe(true);
      } else {
        expect(imageText).toContain("[Image omitted:");
      }

      const textPath = path.join(tmpDir, "sample.txt");
      const contents = "Hello from openclaw read tool.";
      await fs.writeFile(textPath, contents, "utf8");

      const textResult = await readExecute("tool-2", {
        path: textPath,
      });

      expect(textResult?.content).toEqual([{ type: "text", text: contents }]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters tools by sandbox policy", () => {
    const sandboxDir = path.join(os.tmpdir(), "openclaw-sandbox");
    const sandbox = createAgentToolsSandboxContext({
      workspaceDir: sandboxDir,
      agentWorkspaceDir: path.join(os.tmpdir(), "openclaw-workspace"),
      workspaceAccess: "none" as const,
      fsBridge: createHostSandboxFsBridge(sandboxDir),
      tools: {
        allow: ["bash"],
        deny: ["browser"],
      },
    });
    const tools = createOpenClawCodingTools({ sandbox });
    expect(toolNameList(tools)).toContain("exec");
    expect(toolNameList(tools)).not.toContain("read");
    expect(toolNameList(tools)).not.toContain("browser");
  });

  it("hard-disables write/edit when sandbox workspaceAccess is ro", () => {
    const sandboxDir = path.join(os.tmpdir(), "openclaw-sandbox");
    const sandbox = createAgentToolsSandboxContext({
      workspaceDir: sandboxDir,
      agentWorkspaceDir: path.join(os.tmpdir(), "openclaw-workspace"),
      workspaceAccess: "ro" as const,
      fsBridge: createHostSandboxFsBridge(sandboxDir),
      tools: {
        allow: ["read", "write", "edit"],
        deny: [],
      },
    });
    const tools = createOpenClawCodingTools({ sandbox });
    expect(toolNameList(tools)).toContain("read");
    expect(toolNameList(tools)).not.toContain("write");
    expect(toolNameList(tools)).not.toContain("edit");
  });

  it("accepts canonical parameters for read/write/edit", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-canonical-"));
    try {
      const tools = createOpenClawCodingTools({ workspaceDir: tmpDir });
      const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);

      const filePath = "canonical-test.txt";
      await writeTool?.execute("tool-canonical-1", {
        path: filePath,
        content: "hello world",
      });

      await editTool?.execute("tool-canonical-2", {
        path: filePath,
        edits: [{ oldText: "world", newText: "universe" }],
      });

      const result = await readTool?.execute("tool-canonical-3", {
        path: filePath,
      });

      const textBlocks = result?.content?.filter((block) => block.type === "text") as
        | Array<{ text?: string }>
        | undefined;
      const combinedText = textBlocks?.map((block) => block.text ?? "").join("\n");
      expect(combinedText).toContain("hello universe");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("roots memory flush append-only writes in the workspace when cwd differs", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-workspace-"));
    const taskCwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-cwd-"));
    const memoryRelativePath = "memory/2026-03-24.md";
    const workspaceMemoryFile = path.join(workspaceDir, memoryRelativePath);
    const taskMemoryFile = path.join(taskCwd, memoryRelativePath);

    try {
      await fs.mkdir(path.dirname(workspaceMemoryFile), { recursive: true });
      await fs.writeFile(workspaceMemoryFile, "seed", "utf8");

      const tools = createOpenClawCodingTools({
        workspaceDir,
        cwd: taskCwd,
        trigger: "memory",
        memoryFlushWritePath: memoryRelativePath,
      });
      const writeExecute = requireToolExecute(requireTool(tools, "write"));

      await writeExecute("tool-memory-flush-workspace", {
        path: memoryRelativePath,
        content: "new durable note",
      });

      await expect(fs.readFile(workspaceMemoryFile, "utf8")).resolves.toBe(
        "seed\nnew durable note",
      );
      await expect(fs.stat(taskMemoryFile)).rejects.toThrow();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(taskCwd, { recursive: true, force: true });
    }
  });

  it("rejects legacy alias parameters", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-alias-"));
    try {
      const tools = createOpenClawCodingTools({ workspaceDir: tmpDir });
      const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);

      await expect(
        writeTool?.execute("tool-legacy-write", {
          file: "legacy.txt",
          content: "hello old value",
        }),
      ).rejects.toThrow(/Missing required parameter: path/);

      await expect(
        editTool?.execute("tool-legacy-edit", {
          filePath: "legacy.txt",
          old_text: "old",
          newString: "new",
        }),
      ).rejects.toThrow(/Missing required parameters: path, edits/);

      await expect(
        readTool?.execute("tool-legacy-read", {
          file_path: "legacy.txt",
        }),
      ).rejects.toThrow(/Missing required parameter: path/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects structured content blocks for write", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-structured-write-"));
    try {
      const tools = createOpenClawCodingTools({ workspaceDir: tmpDir });
      const writeTool = requireTool(tools, "write");
      const writeExecute = requireToolExecute(writeTool);

      await expect(
        writeExecute("tool-structured-write", {
          path: "structured-write.js",
          content: [
            { type: "text", text: "const path = require('path');\n" },
            { type: "input_text", text: "const root = path.join(process.env.HOME, 'clawd');\n" },
          ],
        }),
      ).rejects.toThrow(/Missing required parameter: content/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects structured edit payloads", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-structured-edit-"));
    try {
      const filePath = path.join(tmpDir, "structured-edit.js");
      await fs.writeFile(filePath, "const value = 'old';\n", "utf8");

      const tools = createOpenClawCodingTools({ workspaceDir: tmpDir });
      const editTool = requireTool(tools, "edit");
      const editExecute = requireToolExecute(editTool);

      await expect(
        editExecute("tool-structured-edit", {
          path: "structured-edit.js",
          edits: [
            {
              oldText: [{ type: "text", text: "old" }],
              newText: [{ kind: "text", value: "new" }],
            },
          ],
        }),
      ).rejects.toThrow(/Missing required parameter: edits/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
