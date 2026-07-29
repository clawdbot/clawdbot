// Feishu tests cover wiki plugin pagination behavior.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, PluginRuntime } from "../runtime-api.js";

const createFeishuToolClientMock = vi.hoisted(() => vi.fn());
const resolveAnyEnabledFeishuToolsConfigMock = vi.hoisted(() => vi.fn());

vi.mock("./tool-account.js", () => ({
  createFeishuToolClient: createFeishuToolClientMock,
  resolveAnyEnabledFeishuToolsConfig: resolveAnyEnabledFeishuToolsConfigMock,
}));

let registerFeishuWikiTools: typeof import("./wiki.js").registerFeishuWikiTools;

type FeishuWikiTool = {
  parameters: { properties?: Record<string, unknown> };
  execute: (callId: string, input: Record<string, unknown>) => Promise<{ details?: unknown }>;
};

type FeishuWikiToolFactory = (context: { agentAccountId?: string }) => FeishuWikiTool;

function createFeishuToolRuntime(): PluginRuntime {
  return {} as PluginRuntime;
}

function createWikiToolApi(registerTool: OpenClawPluginApi["registerTool"]): OpenClawPluginApi {
  return createTestPluginApi({
    id: "feishu-test",
    name: "Feishu Test",
    source: "local",
    config: {
      channels: {
        feishu: {
          enabled: true,
          appId: "app_id",
          appSecret: "app_secret", // pragma: allowlist secret
          tools: { wiki: true },
        },
      },
    },
    runtime: createFeishuToolRuntime(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerTool,
  });
}

function buildWikiTool(): FeishuWikiTool {
  const registerTool = vi.fn();
  registerFeishuWikiTools(createWikiToolApi(registerTool));
  expect(registerTool).toHaveBeenCalledTimes(1);
  const factory = registerTool.mock.calls[0]?.[0] as FeishuWikiToolFactory;
  return factory({ agentAccountId: undefined });
}

describe("registerFeishuWikiTools pagination", () => {
  beforeAll(async () => {
    ({ registerFeishuWikiTools } = await import("./wiki.js"));
  });

  afterAll(() => {
    vi.doUnmock("./tool-account.js");
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resolveAnyEnabledFeishuToolsConfigMock.mockReturnValue({ wiki: true });
  });

  it("nodes: forwards pagination and returns continuation metadata", async () => {
    const spaceNodeList = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [{ node_token: "node-1", obj_type: "docx", node_type: "origin" }],
        has_more: true,
        page_token: "page-2",
      },
    });
    createFeishuToolClientMock.mockReturnValue({ wiki: { spaceNode: { list: spaceNodeList } } });

    const result = await buildWikiTool().execute("call-1", {
      action: "nodes",
      space_id: "space-1",
      parent_node_token: "parent-1",
      page_size: 25,
      page_token: "page-1",
    });

    expect(spaceNodeList).toHaveBeenCalledWith({
      path: { space_id: "space-1" },
      params: { parent_node_token: "parent-1", page_size: 25, page_token: "page-1" },
    });
    expect(result.details).toMatchObject({
      nodes: [{ node_token: "node-1" }],
      has_more: true,
      page_token: "page-2",
    });
  });

  it("spaces: defaults page size and returns continuation metadata", async () => {
    const spaceList = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [{ space_id: "space-1", name: "Space 1" }],
        has_more: false,
      },
    });
    createFeishuToolClientMock.mockReturnValue({ wiki: { space: { list: spaceList } } });

    const result = await buildWikiTool().execute("call-1", { action: "spaces" });

    expect(spaceList).toHaveBeenCalledWith({
      params: { page_size: 50, page_token: undefined },
    });
    expect(result.details).toMatchObject({
      spaces: [{ space_id: "space-1" }],
      has_more: false,
    });
  });

  it("spaces: does not emit the access hint for an empty page with a continuation", async () => {
    const spaceList = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [],
        has_more: true,
        page_token: "page-2",
      },
    });
    createFeishuToolClientMock.mockReturnValue({ wiki: { space: { list: spaceList } } });

    const result = await buildWikiTool().execute("call-1", { action: "spaces" });

    expect(result.details).toEqual({
      spaces: [],
      has_more: true,
      page_token: "page-2",
    });
  });

  it("spaces: does not emit the access hint on an empty terminal continuation page", async () => {
    const spaceList = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [],
        has_more: false,
      },
    });
    createFeishuToolClientMock.mockReturnValue({ wiki: { space: { list: spaceList } } });

    const result = await buildWikiTool().execute("call-1", {
      action: "spaces",
      page_token: "page-2",
    });

    expect(result.details).toEqual({
      spaces: [],
      has_more: false,
    });
  });

  it("rejects out-of-range page sizes before calling Feishu", async () => {
    const spaceList = vi.fn();
    createFeishuToolClientMock.mockReturnValue({ wiki: { space: { list: spaceList } } });

    const result = await buildWikiTool().execute("call-1", {
      action: "spaces",
      page_size: 51,
    });

    expect(spaceList).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      error: "page_size must be a positive integer between 1 and 50",
    });
  });
});
