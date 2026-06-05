// Feishu tests cover tool account routing plugin behavior.
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.fn((account: { appId?: string } | undefined) => ({
  __appId: account?.appId,
  wiki: {
    spaceNode: {
      list: vi.fn(async () => ({
        code: 0,
        data: { items: [] },
      })),
    },
  },
}));

vi.mock("./client.js", () => ({
  createFeishuClient: (account: { appId?: string } | undefined) => createFeishuClientMock(account),
}));

let registerFeishuBitableTools: typeof import("./bitable.js").registerFeishuBitableTools;
let registerFeishuDriveTools: typeof import("./drive.js").registerFeishuDriveTools;
let registerFeishuPermTools: typeof import("./perm.js").registerFeishuPermTools;
let registerFeishuWikiTools: typeof import("./wiki.js").registerFeishuWikiTools;

function createConfig(params: {
  topTools?: {
    wiki?: boolean;
    drive?: boolean;
    perm?: boolean;
    bitable?: boolean;
    base?: boolean;
  };
  toolsA?: {
    wiki?: boolean;
    drive?: boolean;
    perm?: boolean;
    bitable?: boolean;
    base?: boolean;
  };
  toolsB?: {
    wiki?: boolean;
    drive?: boolean;
    perm?: boolean;
    bitable?: boolean;
    base?: boolean;
  };
  defaultAccount?: string;
}): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        defaultAccount: params.defaultAccount,
        tools: params.topTools,
        accounts: {
          a: {
            appId: "app-a",
            appSecret: "sec-a", // pragma: allowlist secret
            tools: params.toolsA,
          },
          b: {
            appId: "app-b",
            appSecret: "sec-b", // pragma: allowlist secret
            tools: params.toolsB,
          },
        },
      },
    },
  } as OpenClawPluginApi["config"];
}

function clientAppIdAt(index: number): string | undefined {
  const calls = createFeishuClientMock.mock.calls;
  const resolvedIndex = index < 0 ? calls.length + index : index;
  return calls[resolvedIndex]?.[0]?.appId;
}

function lastClientAppId(): string | undefined {
  return clientAppIdAt(-1);
}

describe("feishu tool account routing", () => {
  beforeAll(async () => {
    ({ registerFeishuBitableTools, registerFeishuDriveTools, registerFeishuPermTools } =
      await import("./bitable.js").then(
        async ({ registerFeishuBitableTools: registerFeishuBitableToolsLocal }) => ({
          registerFeishuBitableTools: registerFeishuBitableToolsLocal,
          ...(await import("./drive.js")),
          ...(await import("./perm.js")),
          ...(await import("./wiki.js")),
        }),
      ));
    ({ registerFeishuWikiTools } = await import("./wiki.js"));
  });

  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("wiki tool registers when first account disables it and routes to agentAccountId", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { wiki: false },
        toolsB: { wiki: true },
      }),
    );
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki", { agentAccountId: "b" });
    await tool.execute("call", { action: "search" });

    expect(lastClientAppId()).toBe("app-b");
  });

  test("wiki tool prefers the active contextual account over configured defaultAccount", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        defaultAccount: "b",
        toolsA: { wiki: true },
        toolsB: { wiki: true },
      }),
    );
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki", { agentAccountId: "a" });
    await tool.execute("call", { action: "search" });

    expect(lastClientAppId()).toBe("app-a");
  });

  test("wiki tool rejects number-typed space IDs before Lark receives precision-corrupted values", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { wiki: true },
      }),
    );
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "nodes",
      space_id: 7616123456789015000,
    });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toContain("space_id must be a string");
    expect(result.details.error).toContain("precision loss");
  });

  test("wiki tool forwards quoted numeric-looking space IDs unchanged", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { wiki: true },
      }),
    );
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki", { agentAccountId: "a" });
    await tool.execute("call", {
      action: "nodes",
      space_id: "7616123456789014828",
    });

    const client = createFeishuClientMock.mock.results[0]?.value;
    expect(client.wiki.spaceNode.list).toHaveBeenCalledWith({
      path: { space_id: "7616123456789014828" },
      params: { parent_node_token: undefined },
    });
  });

  test("drive tool registers when first account disables it and routes to agentAccountId", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { drive: false },
        toolsB: { drive: true },
      }),
    );
    registerFeishuDriveTools(api);

    const tool = resolveTool("feishu_drive", { agentAccountId: "b" });
    await tool.execute("call", { action: "unknown_action" });

    expect(lastClientAppId()).toBe("app-b");
  });

  test("perm tool registers when only second account enables it and routes to agentAccountId", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { perm: false },
        toolsB: { perm: true },
      }),
    );
    registerFeishuPermTools(api);

    const tool = resolveTool("feishu_perm", { agentAccountId: "b" });
    await tool.execute("call", { action: "unknown_action" });

    expect(lastClientAppId()).toBe("app-b");
  });

  test("bitable tool registers when only second account enables it and routes to agentAccountId", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { bitable: false },
        toolsB: { bitable: true },
      }),
    );
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_get_meta", { agentAccountId: "b" });
    await tool.execute("call", { url: "invalid-url" });

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-b");
  });

  test("bitable tool rejects a disabled contextual account when another account enables it", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { bitable: false },
        toolsB: { bitable: true },
      }),
    );
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_get_meta", { agentAccountId: "a" });
    const result = await tool.execute("call", { url: "invalid-url" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu Bitable tools are disabled for account "a"');
  });

  test("bitable tool rejects an explicit disabled account override", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { bitable: false },
        toolsB: { bitable: true },
      }),
    );
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_get_meta", { agentAccountId: "b" });
    const result = await tool.execute("call", { url: "invalid-url", accountId: "a" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu Bitable tools are disabled for account "a"');
  });

  test("bitable tool routes to agentAccountId and allows explicit accountId override", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig({}));
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_get_meta", { agentAccountId: "b" });
    await tool.execute("call-ctx", { url: "invalid-url" });
    await tool.execute("call-override", { url: "invalid-url", accountId: "a" });

    expect(clientAppIdAt(0)).toBe("app-b");
    expect(clientAppIdAt(1)).toBe("app-a");
  });

  test("bitable tools are not registered when top-level bitable config disables them", async () => {
    const { api, registered, resolveTool } = createToolFactoryHarness(
      createConfig({
        topTools: { bitable: false },
      }),
    );
    registerFeishuBitableTools(api);

    expect(
      registered.filter((entry) => entry.opts?.name?.startsWith("feishu_bitable_")).length,
    ).toBe(0);
    expect(() => resolveTool("feishu_bitable_get_meta")).toThrow("Tool not registered");
  });

  test("top-level bitable disable wins over account-level bitable enable", async () => {
    const { api, registered, resolveTool } = createToolFactoryHarness(
      createConfig({
        topTools: { bitable: false },
        toolsA: { bitable: true },
        toolsB: { bitable: true },
      }),
    );
    registerFeishuBitableTools(api);

    expect(
      registered.filter((entry) => entry.opts?.name?.startsWith("feishu_bitable_")).length,
    ).toBe(0);
    expect(() => resolveTool("feishu_bitable_get_meta")).toThrow("Tool not registered");
  });

  test("top-level base alias disable wins over account-level bitable enable", async () => {
    const { api, registered } = createToolFactoryHarness(
      createConfig({
        topTools: { base: false },
        toolsA: { bitable: true },
        toolsB: { bitable: true },
      }),
    );
    registerFeishuBitableTools(api);

    expect(
      registered.filter((entry) => entry.opts?.name?.startsWith("feishu_bitable_")).length,
    ).toBe(0);
  });

  test("explicit top-level bitable enable wins over disabled base alias in account merge", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        topTools: { bitable: true, base: false },
        toolsA: { bitable: true },
      }),
    );
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_get_meta", { agentAccountId: "a" });
    await tool.execute("call", { url: "invalid-url" });

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-a");
  });

  test("account base alias disable wins over inherited top-level bitable enable", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        topTools: { bitable: true },
        toolsA: { base: false },
        toolsB: { bitable: true },
      }),
    );
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_get_meta", { agentAccountId: "a" });
    const result = await tool.execute("call", { url: "invalid-url" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu Bitable tools are disabled for account "a"');
  });

  test("bitable tools are not registered when account bitable configs disable them", async () => {
    const { api, registered, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { bitable: false },
        toolsB: { bitable: false },
      }),
    );
    registerFeishuBitableTools(api);

    expect(
      registered.filter((entry) => entry.opts?.name?.startsWith("feishu_bitable_")).length,
    ).toBe(0);
    expect(() => resolveTool("feishu_bitable_get_meta")).toThrow("Tool not registered");
  });

  test("base alias disables bitable tool registration", async () => {
    const { api, registered } = createToolFactoryHarness(
      createConfig({
        topTools: { base: false },
        toolsA: { base: false },
        toolsB: { base: false },
      }),
    );
    registerFeishuBitableTools(api);

    expect(
      registered.filter((entry) => entry.opts?.name?.startsWith("feishu_bitable_")).length,
    ).toBe(0);
  });

  test("falls back to the configured Feishu default selection when agentAccountId is not a real account", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { wiki: true },
        toolsB: { wiki: true },
      }),
    );
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki", { agentAccountId: "agent-spawner" });
    await tool.execute("call", { action: "search" });

    expect(lastClientAppId()).toBe("app-a");
  });

  test("does not silently fall back when the contextual account is real but uses non-env SecretRefs", async () => {
    const { api, resolveTool } = createToolFactoryHarness({
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            a: {
              appId: "app-a",
              appSecret: "sec-a", // pragma: allowlist secret
              tools: { wiki: true },
            },
            b: {
              appId: "app-b",
              appSecret: { source: "file", provider: "default", id: "feishu/b-secret" },
              tools: { wiki: true },
            } as never,
          },
        },
      },
    } as OpenClawPluginApi["config"]);
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki", { agentAccountId: "b" });
    const result = await tool.execute("call", { action: "search" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(typeof result.details.error === "string" ? result.details.error : "").toContain(
      "Resolve this command against an active gateway runtime snapshot before reading it.",
    );
  });
});
