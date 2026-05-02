import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, PluginRuntime } from "../runtime-api.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const chatGetMock = vi.hoisted(() => vi.fn());
const chatMembersGetMock = vi.hoisted(() => vi.fn());
const contactUserGetMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

let registerFeishuChatTools: typeof import("./chat.js").registerFeishuChatTools;

function createFeishuToolRuntime(): PluginRuntime {
  return {} as PluginRuntime;
}

describe("registerFeishuChatTools", () => {
  function createChatToolApi(params: {
    config: OpenClawPluginApi["config"];
    registerTool: OpenClawPluginApi["registerTool"];
  }): OpenClawPluginApi {
    return createTestPluginApi({
      id: "feishu-test",
      name: "Feishu Test",
      source: "local",
      config: params.config,
      runtime: createFeishuToolRuntime(),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool: params.registerTool,
    });
  }

  beforeAll(async () => {
    ({ registerFeishuChatTools } = await import("./chat.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({
      im: {
        chat: { get: chatGetMock },
        chatMembers: { get: chatMembersGetMock },
      },
      contact: {
        user: { get: contactUserGetMock },
      },
    });
  });

  it("registers feishu_chat and handles info/members actions", async () => {
    const registerTool = vi.fn();
    registerFeishuChatTools(
      createChatToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { chat: true },
            },
          },
        },
        registerTool,
      }),
    );

    expect(registerTool).toHaveBeenCalledTimes(1);
    const tool = registerTool.mock.calls[0]?.[0];
    expect(tool?.name).toBe("feishu_chat");

    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { name: "group name", user_count: 3 },
    });
    const infoResult = await tool.execute("tc_1", { action: "info", chat_id: "oc_1" });
    expect(infoResult.details).toEqual(
      expect.objectContaining({ chat_id: "oc_1", name: "group name", user_count: 3 }),
    );

    chatMembersGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        page_token: "",
        items: [{ member_id: "ou_1", name: "member1", member_id_type: "open_id" }],
      },
    });
    const membersResult = await tool.execute("tc_2", { action: "members", chat_id: "oc_1" });
    expect(membersResult.details).toEqual(
      expect.objectContaining({
        chat_id: "oc_1",
        members: [expect.objectContaining({ member_id: "ou_1", name: "member1" })],
      }),
    );

    contactUserGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        user: {
          open_id: "ou_1",
          name: "member1",
          email: "member1@example.com",
          department_ids: ["od_1"],
        },
      },
    });
    const memberInfoResult = await tool.execute("tc_3", {
      action: "member_info",
      member_id: "ou_1",
    });
    expect(memberInfoResult.details).toEqual(
      expect.objectContaining({
        member_id: "ou_1",
        open_id: "ou_1",
        name: "member1",
        email: "member1@example.com",
        department_ids: ["od_1"],
      }),
    );
  });

  it("skips registration when chat tool is disabled", () => {
    const registerTool = vi.fn();
    registerFeishuChatTools(
      createChatToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { chat: false },
            },
          },
        },
        registerTool,
      }),
    );
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("preserves Feishu diagnostics from rejected member lookups", async () => {
    const registerTool = vi.fn();
    registerFeishuChatTools(
      createChatToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { chat: true },
            },
          },
        },
        registerTool,
      }),
    );

    const tool = registerTool.mock.calls[0]?.[0];
    contactUserGetMock.mockRejectedValueOnce(
      Object.assign(new Error("Request failed with status code 400"), {
        response: {
          status: 400,
          data: {
            code: 99992360,
            msg: "The request you send is not a valid {user_id} or not exists",
            error: {
              log_id: "20260429124800CHAT",
              troubleshooter: "https://open.feishu.cn/search?log_id=20260429124800CHAT",
            },
          },
        },
      }),
    );

    const result = await tool.execute("tc_4", {
      action: "member_info",
      member_id: "ou_1",
    });

    expect(result.details.error).toContain('"http_status":400');
    expect(result.details.error).toContain('"feishu_code":99992360');
    expect(result.details.error).toContain(
      '"feishu_msg":"The request you send is not a valid {user_id} or not exists"',
    );
    expect(result.details.error).toContain('"feishu_log_id":"20260429124800CHAT"');
    expect(result.details.error).toContain(
      '"feishu_troubleshooter":"https://open.feishu.cn/search?log_id=20260429124800CHAT"',
    );
  });
});
