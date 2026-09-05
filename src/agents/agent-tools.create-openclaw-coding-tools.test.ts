/**
 * Broad coverage for createOpenClawCodingTools.
 * Verifies plugin tools, tool policy, schema cleanup, sandbox fs tools, and
 * assembled tool allowlist behavior.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as windowsEncoding from "../infra/windows-encoding.js";
import { readMemoryArtifactProvenance } from "../memory/memory-artifact-provenance.js";
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
import { createPluginToolAllowlist } from "../plugins/tool-grant-allowlist.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { filterToolsByMessageProvider } from "./agent-tools.message-provider-policy.js";
import {
  createOpenClawReadTool,
  createSandboxedReadTool,
  wrapReadToolWithSkillContent,
} from "./agent-tools.read.js";
import { runWithAgentRingZeroTools } from "./agent-tools.ring-zero-context.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapabilityResolver,
} from "./cron-creator-authority-context.js";
import * as openClawPluginTools from "./openclaw-plugin-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { expectReadWriteEditTools } from "./test-helpers/agent-tools-fs-helpers.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { stubTool } from "./test-helpers/fast-tool-stubs.js";
import {
  createContainerWorkspaceSandboxFsBridge,
  createHostSandboxFsBridge,
  createSandboxFsBridgeFromResolver,
} from "./test-helpers/host-sandbox-fs-bridge.js";
import { buildEmptyExplicitToolAllowlistError } from "./tool-allowlist-guard.js";
import { DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY, normalizeToolPolicyName } from "./tool-policy.js";
import { replaceWithEffectiveCronCreatorToolAllowlist } from "./tools/cron-tool.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const tinyPngBuffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2f7z8AAAAASUVORK5CYII=",
  "base64",
);
const avifHeaderBuffer = Buffer.from("00000018667479706176696600000000617669666d696631", "hex");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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
  const allowSet = new Set(toolsAllow.map((name) => normalizeToolPolicyName(name)));
  return tools.filter((tool) => allowSet.has(normalizeToolPolicyName(tool.name)));
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
  it("forwards the session web-search gate to core tool materialization", () => {
    vi.mocked(createOpenClawTools).mockClear();
    createOpenClawCodingTools({ webSearchEnabled: false });

    expect(latestCreateOpenClawToolsOptions().webSearchEnabled).toBe(false);
  });

  it.each([
    {
      name: "fitting node",
      backend: "node",
      content: "# Pond\nassembled-marker",
      oversized: false,
    },
    {
      name: "multi-page node",
      backend: "node",
      content: `${"ok\n".repeat(2_100)}done`,
      oversized: false,
    },
    {
      name: "oversized node",
      backend: "node",
      content: `# Pond\n${"x".repeat(33 * 1024)}`,
      oversized: true,
    },
    { name: "fitting local", backend: "local", content: "# Pond\nlocal-marker", oversized: false },
    {
      name: "oversized local",
      backend: "local",
      content: `# Pond\n${"x".repeat(33 * 1024)}`,
      oversized: true,
    },
  ])(
    "serves $name skill instructions whole or refuses them",
    async ({ backend, content, oversized }) => {
      const virtual = backend === "node";
      const baseDir = virtual
        ? "node://node-1/skills/pond"
        : tempDirs.make("openclaw-assembled-local-skill-");
      const locator = virtual ? `${baseDir}/SKILL.md` : path.join(baseDir, "SKILL.md");
      if (!virtual) {
        await fs.writeFile(locator, content, "utf8");
      }
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
              baseDir,
              ...(virtual ? { readContent: content } : {}),
              source: virtual ? "openclaw-node" : "test",
              sourceInfo: {
                source: virtual ? "openclaw-node" : "test",
                path: locator,
                scope: "temporary",
                origin: "top-level",
              },
              disableModelInvocation: false,
            },
          ],
        },
      });

      const result = await requireTool(tools, "read").execute("whole-skill-read", {
        path: locator,
      });

      if (oversized) {
        expect(extractToolText(result)).toMatch(
          /(?:cannot|omitted|exceeds).*whole|whole.*(?:cannot|exceeds)|partially served/i,
        );
        expect(extractToolText(result)).not.toContain("# Pond");
        expect(Buffer.byteLength(extractToolText(result), "utf8")).toBeLessThanOrEqual(32 * 1024);
        return;
      }

      expect(extractToolText(result)).toBe(content);
    },
  );

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

  it("passes explicit channel and requester facts to wrapped tool hooks", async () => {
    const beforeToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hook-channel-"));
    await fs.writeFile(path.join(tmpDir, "note.txt"), "hello");
    const memberRoleIds = ["maintainer-role"];
    const tools = createOpenClawCodingTools({
      workspaceDir: tmpDir,
      messageChannel: "discord",
      agentAccountId: "operations",
      currentChannelId: "telegram:-100123",
      hookChannelId: "-100123",
      memberRoleIds,
      senderId: "maintainer-user",
      senderIsOwner: false,
    });
    memberRoleIds.push("late-role");
    const readTool = requireTool(tools, "read");
    await requireToolExecute(readTool)("tool-hook-channel", { path: "note.txt" });

    expect(beforeToolCall).toHaveBeenCalledTimes(1);
    expect(beforeToolCall.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        channelId: "-100123",
        requester: {
          channel: "discord",
          accountId: "operations",
          senderId: "maintainer-user",
          senderIsOwner: false,
          roleIds: ["maintainer-role"],
        },
      }),
    );
  });

  it("binds configured MCP cron authority only to the exact admitted run", async () => {
    const resolve = vi.fn().mockResolvedValue({
      tools: ["read", { name: "mcp_todoist_add_task", pluginId: "todoist" }],
      provenance: { version: 1, source: "final-executable-surface" },
    });
    let releaseRun: (() => void) | undefined;
    const holdRun = new Promise<void>((resolveHold) => {
      releaseRun = resolveHold;
    });
    let retainedResolver: (() => Promise<unknown>) | undefined;

    vi.mocked(createOpenClawTools).mockClear();
    const forgedTools = runWithCronCreatorAuthorityCapabilityResolver({
      capability: undefined,
      runId: "forged-run",
      resolve,
      run: () => createOpenClawCodingTools({ runId: "forged-run", senderIsOwner: false }),
    });
    expect(toolNameList(forgedTools)).not.toContain("automations");
    expect(
      vi.mocked(createOpenClawTools).mock.lastCall?.[0]?.resolveCronCreatorToolAuthority,
    ).toBeUndefined();

    const capability = createCronCreatorAuthorityCapability("admitted-run")!;
    const activeRun = runWithCronCreatorAuthorityCapability(capability, async () => {
      const wrongRunTools = runWithCronCreatorAuthorityCapabilityResolver({
        capability,
        runId: "other-run",
        resolve,
        run: () => createOpenClawCodingTools({ runId: "admitted-run", senderIsOwner: false }),
      });
      expect(toolNameList(wrongRunTools)).not.toContain("automations");
      expect(
        vi.mocked(createOpenClawTools).mock.lastCall?.[0]?.resolveCronCreatorToolAuthority,
      ).toBeUndefined();

      const admittedTools = runWithCronCreatorAuthorityCapabilityResolver({
        capability,
        runId: "admitted-run",
        resolve,
        run: () => createOpenClawCodingTools({ runId: "admitted-run", senderIsOwner: false }),
      });
      const admittedToolNames = toolNameList(admittedTools);
      expect(admittedToolNames).toContain("automations");
      expect(admittedToolNames).not.toContain("gateway");
      expect(admittedToolNames).not.toContain("nodes");
      expect(admittedToolNames).not.toContain("openclaw");
      retainedResolver =
        vi.mocked(createOpenClawTools).mock.lastCall?.[0]?.resolveCronCreatorToolAuthority;
      expect(retainedResolver).toEqual(expect.any(Function));
      await expect(retainedResolver!()).resolves.toMatchObject({
        provenance: { source: "final-executable-surface" },
      });
      await holdRun;
    });

    releaseRun?.();
    await activeRun;
    await expect(retainedResolver!()).rejects.toThrow(
      "Configured MCP cron authority is no longer active for this run",
    );
    expect(
      toolNameList(createOpenClawCodingTools({ runId: "admitted-run", senderIsOwner: false })),
    ).not.toContain("automations");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("drops senderless Automations retention when exact authority aborts or errors", async () => {
    const resolve = async () => ({
      tools: ["read"],
      provenance: { version: 1 as const, source: "final-executable-surface" as const },
    });
    const buildTools = (capability: ReturnType<typeof createCronCreatorAuthorityCapability>) =>
      runWithCronCreatorAuthorityCapabilityResolver({
        capability,
        runId: "lifecycle-run",
        resolve,
        run: () => createOpenClawCodingTools({ runId: "lifecycle-run", senderIsOwner: false }),
      });

    const abortController = new AbortController();
    const abortedCapability = createCronCreatorAuthorityCapability("lifecycle-run")!;
    await runWithCronCreatorAuthorityCapability(
      abortedCapability,
      async () => {
        expect(toolNameList(buildTools(abortedCapability))).toContain("automations");
        abortController.abort(new Error("run cancelled"));
        expect(toolNameList(buildTools(abortedCapability))).not.toContain("automations");
      },
      abortController.signal,
    );
    expect(abortedCapability.active).toBe(false);

    const failedCapability = createCronCreatorAuthorityCapability("lifecycle-run")!;
    await expect(
      runWithCronCreatorAuthorityCapability(failedCapability, async () => {
        expect(toolNameList(buildTools(failedCapability))).toContain("automations");
        throw new Error("run failed");
      }),
    ).rejects.toThrow("run failed");
    expect(failedCapability.active).toBe(false);
    expect(
      toolNameList(createOpenClawCodingTools({ runId: "lifecycle-run", senderIsOwner: false })),
    ).not.toContain("automations");
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

    expect(names.has("automations")).toBe(true);
    expect(names.has("gateway")).toBe(true);
    expect(names.has("nodes")).toBe(true);
  });

  it("resolves isolated cron runtime toolsAllow", () => {
    const allowed = applyRuntimeToolsAllow(
      createOpenClawCodingTools({
        config: testConfig,
      }),
      ["automations"],
    );

    expect(allowed.map((tool) => tool.name)).toEqual(["automations"]);
    expect(
      buildEmptyExplicitToolAllowlistError({
        sources: [{ label: "runtime toolsAllow", entries: ["automations"] }],
        hasCallableTools: allowed.length > 0,
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

  it("does not inherit native-harness bridge runtime allowlists", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: testConfig,
      runtimeToolAllowlist: ["sessions_spawn", "memory_search"],
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    expect(latestCreateOpenClawToolsOptions().pluginToolAllowlist).toEqual([
      "sessions_spawn",
      "memory_search",
    ]);
    expect(latestCreateOpenClawToolsOptions().inheritedToolAllowlist).toEqual([]);
  });

  it("inherits embedded runtime toolsAllow when explicitly marked as parent capability", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();
    const runtimeToolAllowlist = ["sessions_spawn", "memory_search"];

    createOpenClawCodingTools({
      config: testConfig,
      runtimeToolAllowlist,
      conversationCapabilityProfile: resolveConversationCapabilityProfile({
        config: testConfig,
        runtimeToolAllowlist,
        inheritRuntimeToolAllowlist: true,
      }),
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    const inheritedAllow = latestCreateOpenClawToolsOptions().inheritedToolAllowlist;
    expectListIncludes(inheritedAllow, ["sessions_spawn"]);
    expect(inheritedAllow?.includes("read")).toBe(false);
    expect(inheritedAllow?.includes("exec")).toBe(false);
  });

  it("lets direct restricted callers inherit runtime toolsAllow into subagent spawns", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: testConfig,
      runtimeToolAllowlist: ["sessions_spawn", "read"],
      inheritRuntimeToolAllowlist: true,
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    const inheritedAllow = latestCreateOpenClawToolsOptions().inheritedToolAllowlist;
    expectListIncludes(inheritedAllow, ["sessions_spawn", "read"]);
    expect(inheritedAllow?.includes("exec")).toBe(false);
  });

  it("keeps restricted spawn inheritance in the caller-owned runtime snapshot", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();
    const inheritedToolAllowlistRef: string[] = [];

    createOpenClawCodingTools({
      config: { tools: { allow: ["read", "sessions_spawn"] } },
      inheritedToolAllowlistRef,
    });

    expect(latestCreateOpenClawToolsOptions().inheritedToolAllowlist).toBe(
      inheritedToolAllowlistRef,
    );
    expectListIncludes(inheritedToolAllowlistRef, ["read", "sessions_spawn"]);
    expect(inheritedToolAllowlistRef).not.toContain("exec");
  });

  it("does not snapshot additive alsoAllow policies for spawn inheritance", () => {
    const inheritedToolAllowlistRef: string[] = [];

    createOpenClawCodingTools({
      config: { tools: { alsoAllow: ["read"], deny: ["exec"] } },
      inheritedToolAllowlistRef,
    });

    expect(inheritedToolAllowlistRef).toEqual([]);
    expect(latestCreateOpenClawToolsOptions().inheritedToolDenylist).toContain("exec");
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

  it.each([
    {
      name: "trusted one-tool completion",
      trustedInternalHandoff: true,
      sourceTool: "subagent_announce",
      sourceReplyDeliveryMode: "message_tool_only" as const,
      runtimeToolAllowlist: ["message"],
      expected: true,
    },
    {
      name: "ordinary private reply",
      trustedInternalHandoff: false,
      sourceTool: "subagent_announce",
      sourceReplyDeliveryMode: "message_tool_only" as const,
      runtimeToolAllowlist: ["message"],
      expected: false,
    },
    {
      name: "different handoff owner",
      trustedInternalHandoff: true,
      sourceTool: "sessions_send",
      sourceReplyDeliveryMode: "message_tool_only" as const,
      runtimeToolAllowlist: ["message"],
      expected: false,
    },
    {
      name: "unverified forged completion flags",
      trustedInternalHandoff: true,
      sourceTool: "subagent_announce",
      sourceReplyDeliveryMode: "message_tool_only" as const,
      runtimeToolAllowlist: ["message"],
      verifiedLineage: false,
      expected: false,
    },
    {
      name: "wider trusted completion",
      trustedInternalHandoff: true,
      sourceTool: "subagent_announce",
      sourceReplyDeliveryMode: "message_tool_only" as const,
      runtimeToolAllowlist: ["message", "read"],
      expected: true,
    },
    {
      name: "automatic completion delivery",
      trustedInternalHandoff: true,
      sourceTool: "subagent_announce",
      sourceReplyDeliveryMode: "automatic" as const,
      runtimeToolAllowlist: ["message"],
      expected: false,
    },
  ])("limits $name to the source only for verified completion delivery", async (testCase) => {
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-grant-"));
    const storeTemplate = path.join(storeDir, "{agentId}", "sessions.json");
    const requesterSessionKey = "agent:main:discord:direct:alice";
    const requesterSessionId = "requester-session";
    const childSessionKey = "agent:main:subagent:child";
    const childSessionId = "verified-child-session";
    const modelProvider = "openai";
    const modelId = "gpt-5.4";
    const config: OpenClawConfig = { session: { store: storeTemplate } };
    const inputProvenance = {
      kind: "inter_session" as const,
      sourceSessionKey: childSessionKey,
      sourceTool: testCase.sourceTool,
    };
    const trustedInternalHandoff = testCase.trustedInternalHandoff
      ? {
          kind: "subagent-completion" as const,
          sourceSessionKey: childSessionKey,
          sourceSessionId: childSessionId,
          targetSessionKey: requesterSessionKey,
          targetSessionId: requesterSessionId,
          provider: modelProvider,
          model: modelId,
        }
      : undefined;
    const verifiedLineage = !("verifiedLineage" in testCase) || testCase.verifiedLineage !== false;

    try {
      if (verifiedLineage) {
        await writeSessionStore(storeTemplate, "main", {
          [childSessionKey]: {
            sessionId: childSessionId,
            updatedAt: Date.now(),
            spawnedBy: requesterSessionKey,
            spawnDepth: 1,
            subagentRole: "orchestrator",
            subagentControlScope: "children",
            inheritedToolPolicyVersion: 1,
          },
        });
      }
      const conversationCapabilityProfile = resolveConversationCapabilityProfile({
        config,
        agentId: "main",
        sessionKey: requesterSessionKey,
        sessionId: requesterSessionId,
        modelProvider,
        modelId,
        runtimeToolAllowlist: testCase.runtimeToolAllowlist,
        inputProvenance,
        trustedInternalHandoff,
      });
      const isVerifiedHandoff =
        verifiedLineage &&
        testCase.trustedInternalHandoff &&
        testCase.sourceTool === "subagent_announce";
      expect(conversationCapabilityProfile.policy.requesterPolicySource).toBe(
        isVerifiedHandoff ? "completion-handoff" : "current-request",
      );

      vi.mocked(createOpenClawTools).mockClear();
      createOpenClawCodingTools({
        config,
        agentId: "main",
        sessionKey: requesterSessionKey,
        sessionId: requesterSessionId,
        modelProvider,
        modelId,
        conversationCapabilityProfile,
        sourceReplyDeliveryMode: testCase.sourceReplyDeliveryMode,
        runtimeToolAllowlist: testCase.runtimeToolAllowlist,
        ...(!verifiedLineage ? { inputProvenance, trustedInternalHandoff } : {}),
      });

      expect(latestCreateOpenClawToolsOptions().sourceReplyOnly).toBe(testCase.expected);
    } finally {
      await fs.rm(storeDir, { recursive: true, force: true });
    }
  });

  it("passes configured filesystem policy to OpenClaw tool construction", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: { tools: { fs: { workspaceOnly: true } } },
    });

    expect(latestCreateOpenClawToolsOptions().fsPolicy).toEqual({ workspaceOnly: true });
  });

  it.each([
    {
      name: "allowed read policy",
      config: { tools: { allow: ["message", "read"] } },
      sandboxTools: { allow: ["message", "read"], deny: [] },
      expected: true,
    },
    {
      name: "global read denial",
      config: { tools: { allow: ["message"], deny: ["read"] } },
      sandboxTools: { allow: ["message", "read"], deny: [] },
      expected: false,
    },
    {
      name: "sandbox read denial",
      config: { tools: { allow: ["message", "read"] } },
      sandboxTools: { allow: ["message"], deny: ["read"] },
      expected: false,
    },
  ])("prepares sandbox workspace media authorization for $name", (testCase) => {
    vi.mocked(createOpenClawTools).mockClear();
    createOpenClawCodingTools({
      config: testCase.config,
      sandbox: createAgentToolsSandboxContext({
        workspaceDir: "/tmp/sandbox",
        fsBridge: createHostSandboxFsBridge("/tmp/sandbox"),
        tools: testCase.sandboxTools,
      }),
    });

    expect(latestCreateOpenClawToolsOptions().sandboxWorkspaceMediaReadAllowed).toBe(
      testCase.expected,
    );
  });

  it("allows workspace-only reads from declared sandbox bind mounts", async () => {
    const workspaceDir = tempDirs.make("openclaw-sandbox-workspace-");
    const bindRoot = tempDirs.make("openclaw-sandbox-bind-");
    const boundFile = path.join(bindRoot, "example", "tree-index.json");
    await fs.mkdir(path.dirname(boundFile), { recursive: true });
    await fs.writeFile(boundFile, '{"ready":true}\n', "utf8");

    const sandbox = createAgentToolsSandboxContext({
      workspaceDir,
      workspaceAccess: "none",
      dockerOverrides: { binds: [`${bindRoot}:/cache/repos:ro`] },
    });
    sandbox.fsBridge = createSandboxFsBridgeFromResolver((filePath) => {
      const relativePath = path.posix.relative("/cache/repos", filePath);
      return {
        hostPath: path.join(bindRoot, relativePath),
        relativePath,
        containerPath: filePath,
      };
    });

    const tools = createOpenClawCodingTools({
      workspaceDir,
      config: { tools: { fs: { workspaceOnly: true } } },
      sandbox,
    });

    const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);
    const result = await readTool.execute("read-declared-bind", {
      path: "/cache/repos/example/tree-index.json",
    });
    expect(extractToolText(result)).toContain('{"ready":true}');
    await expect(
      writeTool.execute("write-declared-bind", {
        path: "/cache/repos/example/tree-index.json",
        content: "overwritten",
      }),
    ).rejects.toThrow(/Path escapes sandbox root/i);
    await expect(
      editTool.execute("edit-declared-bind", {
        path: "/cache/repos/example/tree-index.json",
        oldText: "true",
        newText: "false",
      }),
    ).rejects.toThrow(/Path escapes sandbox root/i);
    await expect(fs.readFile(boundFile, "utf8")).resolves.toBe('{"ready":true}\n');
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

  it("continues oversized data through the assembled shell-disabled read tool", async () => {
    const workspaceDir = tempDirs.make("openclaw-read-no-shell-");
    const original = JSON.stringify({ generated: "x".repeat(52 * 1024) });
    await fs.writeFile(path.join(workspaceDir, "generated.json"), original, "utf8");
    const tools = createOpenClawCodingTools({
      workspaceDir,
      toolConstructionPlan: {
        includeBaseCodingTools: true,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("exec")).toBe(false);
    expect(names.has("process")).toBe(false);
    const read = requireTool(tools, "read");
    expect(read.description).not.toMatch(/\b(?:bash|sed|head)\b/);

    const result = await read.execute("read-no-shell", { path: "generated.json" });
    const text = extractToolText(result);
    const continuation = (result.details as { continuation?: { cursor?: number } }).continuation;
    expect(text).not.toMatch(/\b(?:bash|sed|head)\b/);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(continuation?.cursor).toBeGreaterThan(0);
    expect(text).toContain(`cursor=${continuation?.cursor}`);
    const next = await read.execute("read-no-shell-next", {
      path: "generated.json",
      cursor: continuation?.cursor,
    });
    expect(extractToolText(next)).toBe(original.slice(continuation?.cursor));
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

  it("forwards trusted conversation recall to OpenClaw tool construction", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();
    const conversationRecall = {
      anchorSessionKey: "agent:main:telegram:direct:owner",
      scope: "same-agent-private" as const,
      corpus: "sessions" as const,
    };

    createOpenClawCodingTools({
      config: testConfig,
      conversationRecall,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: true,
      },
    });

    expect(latestCreateOpenClawToolsOptions().conversationRecall).toEqual(conversationRecall);
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
    const preparedModelRuntime = { metadataSnapshot: {} } as never;

    try {
      createOpenClawCodingTools({
        config: testConfig,
        includeCoreTools: false,
        runtimeToolAllowlist: ["memory_search"],
        modelProvider: "openrouter",
        modelId: "openrouter/auto",
        nativeChannelId: "oc_native_chat",
        clientCaps: ["inline-widgets"],
        preparedModelRuntime,
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
      expect(pluginToolOptions?.preparedModelRuntime).toBe(preparedModelRuntime);
    } finally {
      resolvePluginToolsSpy.mockRestore();
    }
  });

  it("includes plugin tools declared for the active built-in profile", () => {
    const resolvePluginToolsSpy = vi
      .spyOn(openClawPluginTools, "resolveOpenClawPluginToolsForOptions")
      .mockReturnValue([
        {
          name: "profiled_plugin_tool",
          label: "Profiled plugin tool",
          description: "Profiled plugin tool test fixture",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => ({
            content: [{ type: "text" as const, text: "ok" }],
            details: {},
          }),
        },
      ]);
    const preparedModelRuntime = {
      metadataSnapshot: {
        plugins: [
          {
            id: "profiled-plugin",
            contracts: { tools: ["profiled_plugin_tool"] },
            toolMetadata: { profiled_plugin_tool: { profiles: ["coding"] } },
          },
        ],
      },
    } as never;

    try {
      const tools = createOpenClawCodingTools({
        config: { tools: { profile: "coding" } },
        includeCoreTools: false,
        preparedModelRuntime,
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: true,
        },
      });

      expect(tools.map((tool) => tool.name)).toEqual(["profiled_plugin_tool"]);
      expect(resolvePluginToolsSpy.mock.calls[0]?.[0].options?.pluginToolAllowlist).toContain(
        "profiled_plugin_tool",
      );
    } finally {
      resolvePluginToolsSpy.mockRestore();
    }
  });

  it("wraps plugin-only tools with scheduled creator authority and live routing context", async () => {
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
        config: {
          ...testConfig,
          channels: {
            discord: {
              accounts: {
                creator: {},
              },
            },
          },
        },
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:alice",
        messageProvider: "discord-voice",
        messageChannel: "discord",
        messageTo: "channel:123",
        agentAccountId: "work",
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "creator",
          ownerOrigin: { kind: "external", channel: "discord" },
        },
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
        turnSourceAccountId: "creator",
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

  it("separates scheduled Gateway authority from the live delivery account", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: testConfig,
      agentAccountId: "delivery",
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:discord:group:ops",
        ownerAccountId: "creator",
        ownerOrigin: { kind: "external", channel: "discord" },
      },
    });

    expect(latestCreateOpenClawToolsOptions()).toMatchObject({
      agentAccountId: "delivery",
      gatewayCallerAccountId: "creator",
      gatewayCallerChannel: "discord",
      gatewayCallerScheduled: true,
    });
  });

  it("keeps explicit local scheduled authority distinct from live delivery routing", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: testConfig,
      agentAccountId: "delivery",
      messageChannel: "discord",
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:main",
        ownerAccountId: "creator",
        ownerOrigin: { kind: "local" },
      },
    });

    expect(latestCreateOpenClawToolsOptions()).toMatchObject({
      agentAccountId: "delivery",
      gatewayCallerAccountId: "creator",
      gatewayCallerLocal: true,
      gatewayCallerScheduled: true,
    });
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
      createPluginToolAllowlist(latestCreateOpenClawToolsOptions().pluginToolAllowlist).allowsTool(
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

  it("removes message from persisted visible child sessions on every turn", async () => {
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-visible-subagent-message-"));
    const storeTemplate = path.join(storeDir, "{agentId}", "sessions.json");
    const agentId = "visible-subagent-message";
    const childSessionKey = `agent:${agentId}:dashboard:child`;
    const rootSessionKey = `agent:${agentId}:dashboard:root`;
    try {
      await writeSessionStore(storeTemplate, agentId, {
        [childSessionKey]: {
          sessionId: "visible-child",
          updatedAt: Date.now(),
          spawnDepth: 1,
          spawnedBy: `agent:${agentId}:main`,
          subagentRole: "leaf",
          subagentControlScope: "none",
        },
        [rootSessionKey]: {
          sessionId: "root-dashboard",
          updatedAt: Date.now(),
          spawnDepth: 0,
        },
      });

      const firstChildTurn = createToolsForStoredSession(storeTemplate, childSessionKey);
      const resumedChildTurn = createToolsForStoredSession(storeTemplate, childSessionKey);
      const rootTurn = createToolsForStoredSession(storeTemplate, rootSessionKey);

      expect(toolNameList(firstChildTurn)).not.toContain("message");
      expect(toolNameList(resumedChildTurn)).not.toContain("message");
      expect(toolNameList(rootTurn)).toContain("message");
    } finally {
      await fs.rm(storeDir, { recursive: true, force: true });
    }
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
        tools: { allow: ["read", "exec", "process", "automations"] },
        channels: {
          whatsapp: {
            groups: {
              "restricted-room": {
                tools: { allow: ["read", "automations"] },
              },
            },
          },
        },
      },
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    const cronAllow = latestCreateOpenClawToolsOptions().cronCreatorToolAllowlist;
    const cronAllowNames = cronCreatorToolNames(cronAllow);
    expectListIncludes(cronAllowNames, ["read", "automations"]);
    expect(cronAllowNames?.includes("exec")).toBe(false);
    expect(cronAllowNames?.includes("process")).toBe(false);
  });

  it("passes the final unrestricted tool surface to cron-created agent turns", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({ config: {} });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    const cronAllowNames = cronCreatorToolNames(
      latestCreateOpenClawToolsOptions().cronCreatorToolAllowlist,
    );
    expectListIncludes(cronAllowNames, ["read", "automations", "exec"]);
  });

  it("lets embedded attempts refresh a caller-owned cron creator tool surface", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();
    const cronCreatorToolAllowlistRef: NonNullable<
      OpenClawToolsOptions["cronCreatorToolAllowlist"]
    > = [];

    createOpenClawCodingTools({
      config: { tools: { allow: ["read", "automations"] } },
      cronCreatorToolAllowlistRef,
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    const cronAllow = latestCreateOpenClawToolsOptions().cronCreatorToolAllowlist;
    expect(cronAllow).toBe(cronCreatorToolAllowlistRef);
    expect(cronCreatorToolNames(cronAllow)).toEqual(["read", "automations"]);

    replaceWithEffectiveCronCreatorToolAllowlist(cronCreatorToolAllowlistRef, [
      stubTool("read"),
      stubTool("automations"),
      stubTool("bundle_mcp_search"),
    ]);

    expect(cronCreatorToolNames(cronAllow)).toEqual(["read", "automations", "bundle_mcp_search"]);
  });

  it("passes deny-restricted tool surface to cron-created agent turns", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      sessionKey: "agent:main:whatsapp:group:restricted-room",
      config: {
        tools: { allow: ["read", "exec", "process", "automations"] },
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
    expectListIncludes(cronAllowNames, ["read", "automations"]);
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
    const actionToolNames = ["canvas", "nodes", "automations", "gateway", "message"];
    const missingNames = actionToolNames.filter(
      (name) => !defaultTools.some((candidate) => candidate.name === name),
    );
    expect(missingNames).toStrictEqual([]);

    for (const name of actionToolNames) {
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
    // Messaging agents can spawn (and manage) sub-sessions since the
    // visible-spawn parity change; execution tools stay coding-only.
    expect(names.has("sessions_spawn")).toBe(true);
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
    expect(names.has("automations")).toBe(true);
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

  it("records restricted memory flush writes without an active memory provider", async () => {
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
        config: { plugins: { slots: { memory: "none" } } },
        trigger: "memory",
        memoryFlushWritePath: memoryRelativePath,
        senderIsOwner: false,
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
      await expect(
        readMemoryArtifactProvenance({ workspaceDir, relativePath: memoryRelativePath }),
      ).resolves.toMatchObject({ originClass: "untrusted" });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(taskCwd, { recursive: true, force: true });
    }
  });

  it("records turn taint and source-session lineage for memory writes, edits, and patches", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-write-taint-"));
    let tainted = false;
    try {
      const tools = createOpenClawCodingTools({
        workspaceDir,
        config: { tools: { fs: { workspaceOnly: true } } },
        sessionId: "source-session",
        sessionKey: "agent:main:policy-session",
        runSessionKey: "agent:main:durable-session",
        senderIsOwner: true,
        isTurnTainted: () => tainted,
      });
      const write = requireToolExecute(requireTool(tools, "write"));
      const edit = requireToolExecute(requireTool(tools, "edit"));
      const applyPatch = requireToolExecute(requireTool(tools, "apply_patch"));

      await write("write-memory", {
        path: "memory/2026-07-29.md",
        content: "owner-requested note\n",
      });
      tainted = true;
      await edit("edit-memory", {
        path: "memory/2026-07-29.md",
        edits: [{ oldText: "note", newText: "network-derived note" }],
      });
      await applyPatch("patch-memory", {
        input: [
          "*** Begin Patch",
          "*** Add File: memory/project.md",
          "+network project note",
          "*** End Patch",
        ].join("\n"),
      });

      await expect(
        Promise.all(
          ["memory/2026-07-29.md", "memory/project.md"].map((relativePath) =>
            readMemoryArtifactProvenance({ workspaceDir, relativePath }),
          ),
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          originClass: "untrusted",
          sessionId: "source-session",
          sessionKey: "agent:main:durable-session",
        }),
        expect.objectContaining({
          originClass: "untrusted",
          sessionId: "source-session",
          sessionKey: "agent:main:durable-session",
        }),
      ]);
      await expect(
        applyPatch("patch-existing-memory", {
          input: [
            "*** Begin Patch",
            "*** Add File: memory/project.md",
            "+replacement",
            "*** End Patch",
          ].join("\n"),
        }),
      ).rejects.toThrow(/file already exists/i);
      await expect(
        readMemoryArtifactProvenance({ workspaceDir, relativePath: "memory/project.md" }),
      ).resolves.toMatchObject({ originClass: "untrusted" });
      await expect(fs.readFile(path.join(workspaceDir, "memory/project.md"), "utf8")).resolves.toBe(
        "network project note\n",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("records agent provenance after an untainted same-turn delete and recreate", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-recreate-"));
    try {
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "memory/recreated.md"), "old\n", "utf8");
      const applyPatch = requireToolExecute(
        requireTool(
          createOpenClawCodingTools({
            workspaceDir,
            senderIsOwner: true,
            isTurnTainted: () => false,
          }),
          "apply_patch",
        ),
      );
      await applyPatch("delete-memory", {
        input: "*** Begin Patch\n*** Delete File: memory/recreated.md\n*** End Patch",
      });
      await applyPatch("recreate-memory", {
        input: "*** Begin Patch\n*** Add File: memory/recreated.md\n+recreated\n*** End Patch",
      });
      await expect(
        readMemoryArtifactProvenance({
          workspaceDir,
          relativePath: "memory/recreated.md",
        }),
      ).resolves.toMatchObject({ originClass: "agent" });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it.each(["relative", "container"])(
    "records sandbox-backed %s memory writes before mutation",
    async (pathKind) => {
      const workspaceDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-memory-sandbox-taint-"),
      );
      const sandboxRoot = path.join(workspaceDir, "private");
      await fs.mkdir(sandboxRoot);
      try {
        const sandbox = createAgentToolsSandboxContext({
          workspaceDir: sandboxRoot,
          agentWorkspaceDir: workspaceDir,
          fsBridge: createContainerWorkspaceSandboxFsBridge(sandboxRoot),
          workspaceAccess: "none",
        });
        const tools = createOpenClawCodingTools({
          workspaceDir,
          sandbox,
          senderIsOwner: true,
          isTurnTainted: () => true,
        });
        const filePath = (relative: string) =>
          pathKind === "container" ? `/workspace/${relative}` : relative;
        await requireToolExecute(requireTool(tools, "write"))("sandbox-project", {
          path: filePath("project.txt"),
          content: "before\n",
        });
        await requireToolExecute(requireTool(tools, "edit"))("sandbox-edit", {
          path: filePath("project.txt"),
          edits: [{ oldText: "before", newText: "after" }],
        });
        await expect(fs.readFile(path.join(sandboxRoot, "project.txt"), "utf8")).resolves.toBe(
          "after\n",
        );
        await requireToolExecute(requireTool(tools, "write"))("sandbox-memory", {
          path: filePath("memory/2026-07-29.md"),
          content: "sandbox network note\n",
        });
        await requireToolExecute(requireTool(tools, "apply_patch"))("sandbox-patch", {
          input: `*** Begin Patch\n*** Add File: ${filePath("memory/nested/project.md")}\n+project note\n*** End Patch`,
        });
        await expect(
          readMemoryArtifactProvenance({
            workspaceDir: sandboxRoot,
            relativePath: "memory/nested/project.md",
          }),
        ).resolves.toMatchObject({ originClass: "untrusted" });

        await expect(
          readMemoryArtifactProvenance({
            workspaceDir: sandboxRoot,
            relativePath: "memory/2026-07-29.md",
          }),
        ).resolves.toMatchObject({ originClass: "untrusted" });
        await expect(
          readMemoryArtifactProvenance({ workspaceDir, relativePath: "memory/2026-07-29.md" }),
        ).resolves.toBeUndefined();
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    },
  );

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

function extractToolText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const textBlock = content.find((block) => {
    return (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    );
  }) as { text?: string } | undefined;
  return textBlock?.text ?? "";
}

describe("createOpenClawCodingTools read behavior", () => {
  it("protects materialized sandbox skill identities when no skill snapshot exists", async () => {
    const root = tempDirs.make("openclaw-sandbox-skill-whole-");
    const relativePath = "skills/demo/SKILL.md";
    const filePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "# Demo\ncomplete instructions", "utf8");
    const sandbox = createAgentToolsSandboxContext({
      workspaceDir: root,
      fsBridge: createContainerWorkspaceSandboxFsBridge(root),
    });
    const tools = createOpenClawCodingTools({
      sandbox,
      skillUsagePaths: [
        {
          readPath: `/workspace/${relativePath}`,
          skillFile: filePath,
          skillName: "demo",
          skillSource: "workspace",
        },
      ],
    });
    const read = requireTool(tools, "read");

    expect(extractToolText(await read.execute("sandbox-skill", { path: relativePath }))).toBe(
      "# Demo\ncomplete instructions",
    );
    for (const window of [{ offset: 2 }, { limit: 1 }, { cursor: 0 }]) {
      const windowed = await read.execute("sandbox-skill-window", {
        path: `/workspace/${relativePath}`,
        ...window,
      });
      expect(extractToolText(windowed)).toBe("# Demo\ncomplete instructions");
    }
  });

  it("reads exact node skill locators without sending them to the filesystem backend", async () => {
    const locator = "node://node-1/skills/pond/SKILL.md";
    const execute = vi.fn(async () => {
      throw new Error("filesystem backend should not run");
    });
    const tool = wrapReadToolWithSkillContent(
      {
        name: "read",
        label: "read",
        description: "read a file",
        parameters: {},
        execute,
      } as never,
      [{ filePath: locator, readContent: "# Pond\nremote-marker" }],
    );

    const result = await tool.execute("node-skill-read", { path: locator });

    expect(extractToolText(result)).toContain("remote-marker");
    for (const window of [{ offset: 2 }, { limit: 1 }, { cursor: 0 }]) {
      const windowed = await tool.execute("whole-skill-window", { path: locator, ...window });
      expect(extractToolText(windowed)).toContain("# Pond\nremote-marker");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("deduplicates sequential and concurrent successful skill reads within one attempt", async () => {
    const locator = "/skills/pond/SKILL.md";
    const instructionDeliveryCache = new Map<string, Promise<boolean>>();
    const instructionDeliveryOptions = { instructionDeliveryCache };
    const fullResult = {
      content: [{ type: "text", text: "# Pond\ncomplete instructions" }],
      details: { kind: "text", content: "# Pond\ncomplete instructions" },
    } as AgentToolResult<unknown>;
    let releaseRead = (): void => undefined;
    const pendingRead = new Promise<AgentToolResult<unknown>>((resolve) => {
      releaseRead = () => resolve(fullResult);
    });
    const execute = vi.fn(() => pendingRead);
    const tool = wrapReadToolWithSkillContent(
      {
        name: "read",
        label: "read",
        description: "read a file",
        parameters: {},
        execute,
      } as never,
      [{ filePath: locator }],
      instructionDeliveryOptions,
    );

    const first = tool.execute("first-skill-read", { path: locator });
    const concurrent = tool.execute("concurrent-skill-read", { path: locator });
    expect(execute).toHaveBeenCalledTimes(1);
    releaseRead();

    expect(extractToolText(await first)).toBe("# Pond\ncomplete instructions");
    expect(extractToolText(await concurrent)).toContain("already served whole");
    expect(
      extractToolText(await tool.execute("sequential-skill-read", { path: locator })),
    ).toContain("already served whole");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retries skill reads after failures, whole-read refusals, and optional misses", async () => {
    const locator = "/skills/pond/SKILL.md";
    const instructionDeliveryCache = new Map<string, Promise<boolean>>();
    const instructionDeliveryOptions = { instructionDeliveryCache };
    const fullResult = {
      content: [{ type: "text", text: "# Pond\ncomplete instructions" }],
      details: { kind: "text", content: "# Pond\ncomplete instructions" },
    } as AgentToolResult<unknown>;
    const truncatedResult = {
      content: [{ type: "text", text: "partial" }],
      details: { kind: "truncated" },
    } as AgentToolResult<unknown>;
    const notFoundResult = {
      content: [{ type: "text", text: `Optional file not found: ${locator}.` }],
      details: { kind: "not_found", status: "not_found", path: locator, optional: true },
    } as AgentToolResult<unknown>;
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient read failure"))
      .mockResolvedValueOnce(truncatedResult)
      .mockResolvedValueOnce(notFoundResult)
      .mockResolvedValueOnce(fullResult);
    const tool = wrapReadToolWithSkillContent(
      {
        name: "read",
        label: "read",
        description: "read a file",
        parameters: {},
        execute,
      } as never,
      [{ filePath: locator }],
      instructionDeliveryOptions,
    );

    await expect(tool.execute("failed-skill-read", { path: locator })).rejects.toThrow(
      "transient read failure",
    );
    expect(
      extractToolText(await tool.execute("oversized-skill-read", { path: locator })),
    ).toContain("cannot be partially served");
    expect(
      extractToolText(
        await tool.execute("optional-missing-skill-read", { path: locator, optional: true }),
      ),
    ).toContain("Optional file not found");
    expect(extractToolText(await tool.execute("retried-skill-read", { path: locator }))).toBe(
      "# Pond\ncomplete instructions",
    );
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("serves skill instructions again after model-context compaction invalidates the cache", async () => {
    const locator = "node://node-1/skills/pond/SKILL.md";
    const instructionDeliveryCache = new Map<string, Promise<boolean>>();
    const instructionDeliveryOptions = { instructionDeliveryCache };
    const tool = wrapReadToolWithSkillContent(
      {
        name: "read",
        label: "read",
        description: "read a file",
        parameters: {},
        execute: vi.fn(),
      } as never,
      [{ filePath: locator, readContent: "# Pond\ncomplete instructions" }],
      instructionDeliveryOptions,
    );

    expect(extractToolText(await tool.execute("first-skill-read", { path: locator }))).toBe(
      "# Pond\ncomplete instructions",
    );
    expect(extractToolText(await tool.execute("deduped-skill-read", { path: locator }))).toContain(
      "already served whole",
    );

    instructionDeliveryCache.clear();

    expect(
      extractToolText(await tool.execute("post-compaction-skill-read", { path: locator })),
    ).toBe("# Pond\ncomplete instructions");
  });

  it("uses host decoding only for host-backed sandbox paths", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sbx-encoding-"));
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "hello", "utf8");
    const hostBridge = createHostSandboxFsBridge(tmpDir);
    const remoteBridge = {
      ...hostBridge,
      resolvePath: (params: Parameters<typeof hostBridge.resolvePath>[0]) => {
        const { relativePath, containerPath } = hostBridge.resolvePath(params);
        return { relativePath, containerPath };
      },
    };
    const decodeSpy = vi.spyOn(windowsEncoding, "decodeWindowsTextFileBuffer");

    try {
      const hostTool = createSandboxedReadTool({ root: tmpDir, bridge: hostBridge });
      await hostTool.execute("host-read", { path: "notes.txt" });
      expect(decodeSpy).toHaveBeenCalledTimes(1);

      decodeSpy.mockClear();
      const remoteTool = createSandboxedReadTool({ root: tmpDir, bridge: remoteBridge });
      await remoteTool.execute("remote-read", { path: "notes.txt" });
      expect(decodeSpy).not.toHaveBeenCalled();
    } finally {
      decodeSpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("applies sandbox path guards to canonical path", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sbx-"));
    const outsidePath = path.join(os.tmpdir(), "openclaw-outside.txt");
    await fs.writeFile(outsidePath, "outside", "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
      });
      await expect(readTool.execute("sandbox-1", { path: outsidePath })).rejects.toThrow(
        /sandbox root/i,
      );
    } finally {
      await fs.rm(outsidePath, { force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects sandbox directory reads before calling the bridge read operation", async () => {
    const tmpDir = tempDirs.make("openclaw-sbx-directory-");
    const directoryName = "notes";
    await fs.mkdir(path.join(tmpDir, directoryName));
    const hostBridge = createHostSandboxFsBridge(tmpDir);
    const readFile = vi.fn(hostBridge.readFile.bind(hostBridge));
    const readTool = createSandboxedReadTool({
      root: tmpDir,
      bridge: { ...hostBridge, readFile },
    });

    await expect(readTool.execute("sandbox-directory", { path: directoryName })).rejects.toThrow(
      `Read requires a file path, but ${directoryName} is a directory. List the directory, then read a specific file.`,
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it("resolves Unicode-equivalent filenames through sandbox operations", async () => {
    const tmpDir = tempDirs.make("openclaw-sbx-unicode-");
    const storedName = "re\u0301sume\u0301 3.04\u202fPM d\u2019accord.txt";
    await fs.writeFile(path.join(tmpDir, storedName), "sandbox match");
    const readTool = createSandboxedReadTool({
      root: tmpDir,
      bridge: createHostSandboxFsBridge(tmpDir),
    });

    const result = await readTool.execute("sandbox-unicode", {
      path: "r\u00e9sum\u00e9 3.04 PM d'accord.txt",
    });

    expect(extractToolText(result)).toContain("Resolved filename");
    expect(extractToolText(result)).toContain("sandbox match");
  });

  it("classifies sandbox AVIF reads from the already-read buffer", async () => {
    const tmpDir = tempDirs.make("openclaw-sbx-avif-");
    await fs.writeFile(path.join(tmpDir, "photo.bin"), avifHeaderBuffer);
    const hostBridge = createHostSandboxFsBridge(tmpDir);
    const readFile = vi.fn(hostBridge.readFile.bind(hostBridge));
    const readTool = createSandboxedReadTool({
      root: tmpDir,
      bridge: { ...hostBridge, readFile },
    });

    const result = await readTool.execute("sandbox-avif", { path: "photo.bin" });

    expect(extractToolText(result)).toContain("Read image file [image/avif]");
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("auto-pages read output across chunks when context window budget allows", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-autopage-"));
    const filePath = path.join(tmpDir, "big.txt");
    const lines = Array.from(
      { length: 5000 },
      (_unused, i) => `line-${String(i + 1).padStart(4, "0")}`,
    );
    await fs.writeFile(filePath, lines.join("\n"), "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
        modelContextWindowTokens: 200_000,
      });
      const result = await readTool.execute("read-autopage-1", { path: "big.txt" });
      const text = extractToolText(result);
      expect(text).toContain("line-0001");
      expect(text).toContain("line-5000");
      expect(text).not.toContain("Read output capped at");
      expect(text).not.toMatch(/Use offset=\d+ to continue\.\]$/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("maps inbound media refs to sandbox-staged media for reads", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-media-sbx-"));
    const mediaId = "webchat-upload.txt";
    const mediaPath = path.join(tmpDir, "media", "inbound", mediaId);
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.writeFile(mediaPath, "sandbox media", "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
      });
      const result = await readTool.execute("read-media-sbx", {
        path: `media://inbound/${mediaId}`,
      });
      expect(extractToolText(result)).toContain("sandbox media");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("adds capped continuation guidance when aggregated read output reaches budget", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-cap-"));
    const filePath = path.join(tmpDir, "huge.txt");
    const lines = Array.from(
      { length: 8000 },
      (_unused, i) => `line-${String(i + 1).padStart(4, "0")}-abcdefghijklmnopqrstuvwxyz`,
    );
    await fs.writeFile(filePath, lines.join("\n"), "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
      });
      const result = await readTool.execute("read-cap-1", { path: "huge.txt" });
      const text = extractToolText(result);
      expect(text).toContain("line-0001");
      expect(text).toContain("[Read output capped at 32KB for this call. Use offset=");
      expect(text).not.toContain("line-8000");
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32 * 1024);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "without an explicit limit", args: {} },
    { name: "with an explicit line limit", args: { limit: 1 } },
  ])("caps the first read page including its notice $name", async ({ args }) => {
    const root = tempDirs.make("openclaw-read-first-page-cap-");
    const original = "é🦞".repeat(9 * 1024);
    await fs.writeFile(path.join(root, "unicode.txt"), original, "utf8");
    const read = createSandboxedReadTool({ root, bridge: createHostSandboxFsBridge(root) });

    const result = await read.execute("read-first-page-cap", { path: "unicode.txt", ...args });
    const text = extractToolText(result);
    const details = result.details as {
      continuation?: { kind: string; offset: number; cursor: number };
    };

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(details.continuation).toMatchObject({ kind: "cursor", offset: 1 });
    expect(text).toContain(`cursor=${details.continuation?.cursor}`);
    expect(text.replace(/\n\n\[Read output capped[^\]]*\]$/, "")).toBe(
      original.slice(0, details.continuation?.cursor),
    );
  });

  it("describes explicit offsets beyond EOF", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-offset-eof-"));
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "one\ntwo\nthree", "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
      });
      const result = await readTool.execute("read-offset-limit", {
        path: "notes.txt",
        offset: 99,
        limit: 10,
      });

      expect(extractToolText(result)).toBe(
        "Offset 99 is beyond end of file (3 lines total). Retry with offset <= 3.",
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores a trailing newline when describing offsets beyond EOF", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-offset-adaptive-"));
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "one\ntwo\nthree\n", "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
      });
      const result = await readTool.execute("read-offset-adaptive", {
        path: "notes.txt",
        offset: 99,
      });

      expect(extractToolText(result)).toBe(
        "Offset 99 is beyond end of file (3 lines total). Retry with offset <= 3.",
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("stops adaptive pagination when the current page reaches EOF", async () => {
    const readResult: AgentToolResult<unknown> = {
      content: [
        {
          type: "text",
          text: "one\n\n[1 more lines in file. Use offset=2 to continue.]",
        },
      ],
      details: {
        truncation: {
          truncated: true,
          outputLines: 1,
          totalLines: 1,
          firstLineExceedsLimit: false,
        },
      },
    };
    const execute = vi.fn().mockResolvedValue(readResult);
    const readTool = createOpenClawReadTool({
      name: "read",
      label: "read",
      description: "test read",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
      }),
      execute,
    });

    const result = await readTool.execute("read-offset-paging-eof", {
      path: "notes.txt",
      offset: 1,
    });

    expect(extractToolText(result)).toBe("one");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps unrelated read failures loud", async () => {
    const readTool = createOpenClawReadTool({
      name: "read",
      label: "read",
      description: "test read",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
      }),
      execute: vi.fn(async () => {
        throw new Error("read failed");
      }),
    });

    await expect(
      readTool.execute("read-unrelated-error", {
        path: "notes.txt",
        offset: 99,
      }),
    ).rejects.toThrow("read failed");
  });

  it("strips truncation.content details from read results while preserving other fields", async () => {
    const readResult: AgentToolResult<unknown> = {
      content: [{ type: "text" as const, text: "line-0001" }],
      details: {
        truncation: {
          truncated: true,
          outputLines: 1,
          firstLineExceedsLimit: false,
          content: "hidden duplicate payload",
        },
        continuation: { kind: "line", offset: 2 },
      },
    };
    const baseRead: AgentTool = {
      name: "read",
      label: "read",
      description: "test read",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }),
      execute: vi.fn(async () => readResult),
    };

    const wrapped = createOpenClawReadTool(
      baseRead as unknown as Parameters<typeof createOpenClawReadTool>[0],
    );
    const result = await wrapped.execute("read-strip-1", { path: "demo.txt", limit: 1 });

    const details = (result as { details?: { truncation?: Record<string, unknown> } }).details;
    expect(details?.truncation?.truncated).toBe(true);
    expect(details?.truncation?.outputLines).toBe(1);
    expect(details?.truncation?.firstLineExceedsLimit).toBe(false);
    expect(details?.truncation).not.toHaveProperty("content");
  });

  it("redacts env files while preserving config and source reads", async () => {
    const credential = "unquoted-config-credential-1234567890";
    const source = "API_TOKEN = computeToken()";
    const execute = vi.fn(async (_toolCallId: string, args: { path: string }) => {
      const text =
        args.path.endsWith(".ts") || args.path.endsWith(".envrc")
          ? source
          : `api_key: ${credential}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { kind: "text", content: text },
      };
    });
    const readTool = createOpenClawReadTool({
      name: "read",
      label: "read",
      description: "test read",
      parameters: Type.Object({ path: Type.String() }),
      execute,
    });

    const yamlResult = await readTool.execute("read-yaml", { path: "settings.yaml" });
    const envResult = await readTool.execute("read-env", { path: "production.env" });
    const sourceResult = await readTool.execute("read-source", { path: "settings.ts" });
    const envrcResult = await readTool.execute("read-envrc", { path: ".envrc" });

    expect(extractToolText(yamlResult)).toBe(`api_key: ${credential}`);
    expect(extractToolText(envResult)).not.toContain(credential);
    expect(extractToolText(sourceResult)).toBe(source);
    expect(extractToolText(envrcResult)).toBe(source);
  });
});

const DEFAULT_TOOLS = [
  { name: "read" },
  { name: "write" },
  { name: "tts" },
  { name: "web_search" },
];

function toolNames(tools: readonly { name: string }[]): Set<string> {
  return new Set(tools.map((tool) => tool.name));
}

describe("createOpenClawCodingTools message provider policy", () => {
  it.each(["voice", "VOICE", " Voice ", "discord-voice", "DISCORD-VOICE", " Discord-Voice "])(
    "does not expose tts tool for normalized voice provider: %s",
    (messageProvider) => {
      const names = toolNames(filterToolsByMessageProvider(DEFAULT_TOOLS, messageProvider));
      expect(names.has("tts")).toBe(false);
    },
  );

  it("keeps tts tool for non-voice providers", () => {
    const names = toolNames(filterToolsByMessageProvider(DEFAULT_TOOLS, "guildchat"));
    expect(names.has("tts")).toBe(true);
  });

  it("preserves duplicate tool entries while filtering", () => {
    const tools = [
      { name: "read", id: 1 },
      { name: "tts", id: 2 },
      { name: "read", id: 3 },
    ];
    expect(filterToolsByMessageProvider(tools, "voice")).toStrictEqual([
      { name: "read", id: 1 },
      { name: "read", id: 3 },
    ]);
  });
});
