import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureStandalonePluginToolRegistryLoaded,
  resolvePluginTools,
} from "../../plugins/tools.js";
import { ErrorCodes } from "../protocol/index.js";
import { toolsCatalogHandlers } from "./tools-catalog.js";

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn(() => ["main"]),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace-main"),
  resolveAgentDir: vi.fn(() => "/tmp/agents/main/agent"),
}));

const pluginToolMetaState = new Map<string, { pluginId: string; optional: boolean }>();

vi.mock("../../plugins/tools.js", () => ({
  buildPluginToolMetadataKey: (pluginId: string, toolName: string) =>
    JSON.stringify([pluginId, toolName]),
  ensureStandalonePluginToolRegistryLoaded: vi.fn(),
  resolvePluginTools: vi.fn(() => [
    { name: "voice_call", label: "voice_call", description: "Plugin calling tool" },
    {
      name: "matrix_room",
      label: "matrix_room",
      displaySummary: "Summarized Matrix room helper.",
      description: "Matrix room helper\n\nACTIONS:\n- join\n- leave",
    },
  ]),
  getPluginToolMeta: vi.fn((tool: { name: string }) => pluginToolMetaState.get(tool.name)),
}));

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createInvokeParams(params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await toolsCatalogHandlers["tools.catalog"]({
        params,
        respond: respond as never,
        context: { getRuntimeConfig: () => ({}) } as never,
        client: null,
        req: { type: "req", id: "req-1", method: "tools.catalog" },
        isWebchatConnect: () => false,
      }),
  };
}

function firstMockArg(mock: { mock: { calls: unknown[][] } }, label: string): unknown {
  const arg = mock.mock.calls[0]?.[0];
  if (arg === undefined) {
    throw new Error(`Expected ${label}`);
  }
  return arg;
}

describe("tools.catalog handler", () => {
  beforeEach(() => {
    pluginToolMetaState.clear();
    pluginToolMetaState.set("voice_call", { pluginId: "voice-call", optional: true });
    pluginToolMetaState.set("matrix_room", { pluginId: "matrix", optional: false });
  });

  it("rejects invalid params", async () => {
    const { respond, invoke } = createInvokeParams({ extra: true });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.catalog params");
  });

  it("rejects unknown agent ids", async () => {
    const { respond, invoke } = createInvokeParams({ agentId: "unknown-agent" });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("unknown agent id");
  });

  it("returns core groups including tts and excludes plugins when includePlugins=false", async () => {
    const { respond, invoke } = createInvokeParams({ includePlugins: false });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    const payload = call?.[1] as
      | {
          agentId: string;
          groups: Array<{
            id: string;
            source: "core" | "plugin";
            tools: Array<{ id: string; source: "core" | "plugin" }>;
          }>;
        }
      | undefined;
    expect(payload?.agentId).toBe("main");
    const groups = payload?.groups ?? [];
    expect(groups.some((group) => group.source === "plugin")).toBe(false);
    const media = groups.find((group) => group.id === "media");
    expect(media?.tools.map((tool) => `${tool.source}:${tool.id}`) ?? []).toContain("core:tts");
  });

  it("includes plugin groups with plugin metadata", async () => {
    const { respond, invoke } = createInvokeParams({});
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    const payload = call?.[1] as
      | {
          groups: Array<{
            source: "core" | "plugin";
            pluginId?: string;
            tools: Array<{
              id: string;
              source: "core" | "plugin";
              pluginId?: string;
              optional?: boolean;
            }>;
          }>;
        }
      | undefined;
    const pluginGroups = (payload?.groups ?? []).filter((group) => group.source === "plugin");
    expect(pluginGroups.length).toBeGreaterThan(0);
    const voiceCall = pluginGroups
      .flatMap((group) => group.tools)
      .find((tool) => tool.id === "voice_call");
    expect(voiceCall).toEqual({
      id: "voice_call",
      label: "voice_call",
      description: "Plugin calling tool",
      source: "plugin",
      pluginId: "voice-call",
      optional: true,
      risk: undefined,
      tags: undefined,
      defaultProfiles: [],
    });
  });

  it("summarizes plugin tool descriptions the same way as the effective inventory", async () => {
    const { respond, invoke } = createInvokeParams({});
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    const payload = call?.[1] as
      | {
          groups: Array<{
            source: "core" | "plugin";
            tools: Array<{
              id: string;
              description: string;
            }>;
          }>;
        }
      | undefined;
    const matrixRoom = (payload?.groups ?? [])
      .filter((group) => group.source === "plugin")
      .flatMap((group) => group.tools)
      .find((tool) => tool.id === "matrix_room");
    expect(matrixRoom?.description).toBe("Summarized Matrix room helper.");
  });

  it("opts plugin tool catalog loads into gateway subagent binding", async () => {
    const { invoke } = createInvokeParams({});

    await invoke();

    const resolveArgs = firstMockArg(vi.mocked(resolvePluginTools), "resolvePluginTools args") as {
      allowGatewaySubagentBinding?: boolean;
      suppressNameConflicts?: boolean;
      toolAllowlist?: string[];
      context?: {
        agentId?: string;
        workspaceDir?: string;
        agentDir?: string;
      };
      existingToolNames?: Set<string>;
    };
    expect(resolveArgs.allowGatewaySubagentBinding).toBe(true);
    expect(resolveArgs.suppressNameConflicts).toBe(true);
    expect(resolveArgs.toolAllowlist).toEqual(["group:plugins"]);
    expect(resolveArgs.context?.agentId).toBe("main");
    expect(resolveArgs.context?.workspaceDir).toBe("/tmp/workspace-main");
    expect(resolveArgs.context?.agentDir).toBe("/tmp/agents/main/agent");
    expect(resolveArgs.existingToolNames).toBeInstanceOf(Set);
    expect(resolveArgs.existingToolNames?.has("tts")).toBe(true);

    const registryArgs = firstMockArg(
      vi.mocked(ensureStandalonePluginToolRegistryLoaded),
      "registry load args",
    ) as {
      allowGatewaySubagentBinding?: boolean;
      toolAllowlist?: string[];
      context?: {
        agentId?: string;
        workspaceDir?: string;
        agentDir?: string;
      };
    };
    expect(registryArgs.allowGatewaySubagentBinding).toBe(true);
    expect(registryArgs.toolAllowlist).toEqual(["group:plugins"]);
    expect(registryArgs.context).toEqual({
      config: {},
      workspaceDir: "/tmp/workspace-main",
      agentDir: "/tmp/agents/main/agent",
      agentId: "main",
    });
  });
});
