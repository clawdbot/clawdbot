import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.fn((creds: { appId?: string } | undefined) => ({
  __appId: creds?.appId,
}));

function feishuClientAppId(callIndex: number): string | undefined {
  const resolvedIndex =
    callIndex < 0 ? createFeishuClientMock.mock.calls.length + callIndex : callIndex;
  const call = createFeishuClientMock.mock.calls[resolvedIndex];
  if (!call) {
    throw new Error(`expected createFeishuClient call ${callIndex}`);
  }
  return call[0]?.appId;
}

vi.mock("./client.js", () => {
  return {
    createFeishuClient: (creds: { appId?: string } | undefined) => createFeishuClientMock(creds),
  };
});

// Patch SDK import so tool execution can run without network concerns.
vi.mock("@larksuiteoapi/node-sdk", () => {
  return {
    default: {},
  };
});

describe("feishu_doc account selection", () => {
  let registerFeishuDocTools: typeof import("./docx.js").registerFeishuDocTools;

  beforeAll(async () => {
    ({ registerFeishuDocTools } = await import("./docx.js"));
  });

  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createDocEnabledConfig(): OpenClawPluginApi["config"] {
    return {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            a: { appId: "app-a", appSecret: "sec-a", tools: { doc: true } }, // pragma: allowlist secret
            b: { appId: "app-b", appSecret: "sec-b", tools: { doc: true } }, // pragma: allowlist secret
          },
        },
      },
    } as OpenClawPluginApi["config"];
  }

  test("uses agentAccountId context when params omit accountId", async () => {
    const cfg = createDocEnabledConfig();

    const { api, resolveTool } = createToolFactoryHarness(cfg);
    registerFeishuDocTools(api);

    const docToolA = resolveTool("feishu_doc", { agentAccountId: "a" });
    const docToolB = resolveTool("feishu_doc", { agentAccountId: "b" });

    await docToolA.execute("call-a", { action: "list_blocks", doc_token: "d" });
    await docToolB.execute("call-b", { action: "list_blocks", doc_token: "d" });

    expect(createFeishuClientMock).toHaveBeenCalledTimes(2);
    expect(feishuClientAppId(0)).toBe("app-a");
    expect(feishuClientAppId(1)).toBe("app-b");
  });

  test("explicit accountId param overrides agentAccountId context", async () => {
    const cfg = createDocEnabledConfig();

    const { api, resolveTool } = createToolFactoryHarness(cfg);
    registerFeishuDocTools(api);

    const docTool = resolveTool("feishu_doc", { agentAccountId: "b" });
    await docTool.execute("call-override", {
      action: "list_blocks",
      doc_token: "d",
      accountId: "a",
    });

    expect(feishuClientAppId(-1)).toBe("app-a");
  });
});
