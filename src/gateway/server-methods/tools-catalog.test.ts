/**
 * Tests for tool catalog gateway methods and plugin tool visibility.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  ensureStandalonePluginToolRegistryLoaded,
  resolvePluginTools,
} from "../../plugins/tools.js";
import { toolsCatalogHandlers } from "./tools-catalog.js";

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn(() => ["main"]),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace-main"),
  resolveAgentDir: vi.fn(() => "/tmp/agents/main/agent"),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
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

const getActivePluginRegistryMock = vi.hoisted(() => vi.fn<() => unknown>(() => null));
vi.mock("../../plugins/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/runtime.js")>();
  return {
    ...actual,
    getActivePluginRegistry: () =>
      getActivePluginRegistryMock() as ReturnType<typeof actual.getActivePluginRegistry>,
  };
});

type RespondCall = [boolean, unknown?, { code: number; message: string }?];
type CatalogTool = {
  id: string;
  source: "core" | "plugin";
  label?: string;
  description?: string;
  pluginId?: string;
  optional?: boolean;
  risk?: unknown;
  tags?: unknown;
  defaultProfiles?: unknown[];
};
type CatalogGroup = {
  id?: string;
  source: "core" | "plugin";
  pluginId?: string;
  tools: CatalogTool[];
};
type CatalogPayload = {
  agentId?: string;
  groups: CatalogGroup[];
};

function createInvokeParams(params: Record<string, unknown>, config: Record<string, unknown> = {}) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await expectDefined(
        toolsCatalogHandlers["tools.catalog"],
        'toolsCatalogHandlers["tools.catalog"] test invariant',
      )({
        params,
        respond: respond as never,
        context: { getRuntimeConfig: () => config } as never,
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

function respondCall(respond: ReturnType<typeof vi.fn>): RespondCall {
  const call = respond.mock.calls[0] as RespondCall | undefined;
  if (!call) {
    throw new Error("expected respond call");
  }
  return call;
}

function expectInvalidRequest(respond: ReturnType<typeof vi.fn>, message: string) {
  const call = respondCall(respond);
  expect(call[0]).toBe(false);
  expect(call[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
  expect(call[2]?.message).toContain(message);
}

function expectCatalogPayload(respond: ReturnType<typeof vi.fn>): CatalogPayload {
  const call = respondCall(respond);
  expect(call[0]).toBe(true);
  return call[1] as CatalogPayload;
}

describe("tools.catalog handler", () => {
  beforeEach(() => {
    pluginToolMetaState.clear();
    pluginToolMetaState.set("voice_call", { pluginId: "voice-call", optional: true });
    pluginToolMetaState.set("matrix_room", { pluginId: "matrix", optional: false });
    getActivePluginRegistryMock.mockReturnValue(null);
    vi.mocked(ensureStandalonePluginToolRegistryLoaded).mockReturnValue(undefined);
  });

  it("rejects invalid params", async () => {
    const { respond, invoke } = createInvokeParams({ extra: true });
    await invoke();
    expectInvalidRequest(respond, "invalid tools.catalog params");
  });

  it("rejects unknown agent ids", async () => {
    const { respond, invoke } = createInvokeParams({ agentId: "unknown-agent" });
    await invoke();
    expectInvalidRequest(respond, "unknown agent id");
  });

  it("returns core groups including tts and excludes plugins when includePlugins=false", async () => {
    const { respond, invoke } = createInvokeParams({ includePlugins: false });
    await invoke();
    const payload = expectCatalogPayload(respond);
    expect(payload.agentId).toBe("main");
    const groups = payload.groups ?? [];
    expect(groups.some((group) => group.source === "plugin")).toBe(false);
    const media = groups.find((group) => group.id === "media");
    expect(media?.tools.map((tool) => `${tool.source}:${tool.id}`) ?? []).toContain("core:tts");
  });

  it("omits agents_wait until Swarm is enabled for the catalog agent", async () => {
    const disabled = createInvokeParams({ includePlugins: false });
    await disabled.invoke();
    expect(
      expectCatalogPayload(disabled.respond).groups.flatMap((group) =>
        group.tools.map((tool) => tool.id),
      ),
    ).not.toContain("agents_wait");

    const enabled = createInvokeParams({ includePlugins: false }, { tools: { swarm: true } });
    await enabled.invoke();
    expect(
      expectCatalogPayload(enabled.respond).groups.flatMap((group) =>
        group.tools.map((tool) => tool.id),
      ),
    ).toContain("agents_wait");
  });

  it("includes plugin groups with plugin metadata", async () => {
    const { respond, invoke } = createInvokeParams({});
    await invoke();
    const payload = expectCatalogPayload(respond);
    const pluginGroups = payload.groups.filter((group) => group.source === "plugin");
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
    const payload = expectCatalogPayload(respond);
    const matrixRoom = payload.groups
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

  it("projects metadata from the exact tool-discovery registry", async () => {
    const toolRegistry = createEmptyPluginRegistry();
    toolRegistry.toolMetadata = [
      {
        pluginId: "voice-call",
        metadata: {
          toolName: "voice_call",
          displayName: "Voice Call",
          description: "Place a voice call",
          risk: "high",
          tags: ["calling"],
        },
      },
    ] as never;
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.toolMetadata = [
      {
        pluginId: "voice-call",
        metadata: {
          toolName: "voice_call",
          displayName: "Wrong Workspace Voice Call",
          risk: "low",
        },
      },
    ] as never;
    getActivePluginRegistryMock.mockReturnValue(activeRegistry);
    vi.mocked(ensureStandalonePluginToolRegistryLoaded).mockReturnValue(toolRegistry);

    const { respond, invoke } = createInvokeParams({});
    await invoke();
    const payload = expectCatalogPayload(respond);
    const voiceCall = payload.groups
      .filter((group) => group.source === "plugin")
      .flatMap((group) => group.tools)
      .find((tool) => tool.id === "voice_call");
    expect(voiceCall?.label).toBe("Voice Call");
    expect(voiceCall?.risk).toBe("high");
    expect(voiceCall?.tags).toEqual(["calling"]);
    expect(vi.mocked(resolvePluginTools)).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeRegistry: toolRegistry }),
    );
  });
});
