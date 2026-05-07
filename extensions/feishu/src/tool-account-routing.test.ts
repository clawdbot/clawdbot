import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.fn((account: { appId?: string } | undefined) => ({
  __appId: account?.appId,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: (account: { appId?: string } | undefined) => createFeishuClientMock(account),
}));

let registerFeishuBitableTools: typeof import("./bitable.js").registerFeishuBitableTools;
let registerFeishuDriveTools: typeof import("./drive.js").registerFeishuDriveTools;
let registerFeishuPermTools: typeof import("./perm.js").registerFeishuPermTools;
let registerFeishuWikiTools: typeof import("./wiki.js").registerFeishuWikiTools;

function createConfig(params: {
  toolsA?: {
    wiki?: boolean;
    drive?: boolean;
    perm?: boolean;
  };
  toolsB?: {
    wiki?: boolean;
    drive?: boolean;
    perm?: boolean;
  };
  defaultAccount?: string;
}): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        defaultAccount: params.defaultAccount,
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

describe("feishu tool account routing", () => {
  beforeAll(async () => {
    ({ registerFeishuBitableTools, registerFeishuDriveTools, registerFeishuPermTools } =
      await import("./bitable.js").then(async ({ registerFeishuBitableTools }) => ({
        registerFeishuBitableTools,
        ...(await import("./drive.js")),
        ...(await import("./perm.js")),
        ...(await import("./wiki.js")),
      })));
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

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-b");
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

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-a");
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

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-b");
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

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-b");
  });

  test("bitable tool routes to agentAccountId and allows explicit accountId override", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig({}));
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_get_meta", { agentAccountId: "b" });
    await tool.execute("call-ctx", { url: "invalid-url" });
    await tool.execute("call-override", { url: "invalid-url", accountId: "a" });

    expect(createFeishuClientMock.mock.calls[0]?.[0]?.appId).toBe("app-b");
    expect(createFeishuClientMock.mock.calls[1]?.[0]?.appId).toBe("app-a");
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

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-a");
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
