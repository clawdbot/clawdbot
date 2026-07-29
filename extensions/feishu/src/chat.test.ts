// Feishu tests cover chat plugin behavior.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  function resolveRegisteredTool(
    registerTool: ReturnType<typeof vi.fn>,
    context: {
      agentAccountId?: string;
      deliveryAccountId?: string;
      deliveryTo?: string;
      nativeChannelId?: string;
      requesterSenderId?: string;
      conversationReadOrigin?: "delegated" | "direct-operator";
    } = {},
  ) {
    const registered = registerTool.mock.calls[0]?.[0];
    return typeof registered === "function"
      ? registered({
          messageChannel: "feishu",
          agentAccountId: context.agentAccountId ?? "default",
          deliveryContext: {
            channel: "feishu",
            to: context.deliveryTo ?? "oc_1",
            accountId: context.deliveryAccountId ?? context.agentAccountId ?? "default",
          },
          nativeChannelId: context.nativeChannelId,
          requesterSenderId: context.requesterSenderId,
          conversationReadOrigin: context.conversationReadOrigin,
        })
      : registered;
  }

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

  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    chatGetMock.mockResolvedValue({
      code: 0,
      data: { chat_mode: "group", chat_type: "private" },
    });
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
              dmPolicy: "open",
              allowFrom: ["*"],
              groupPolicy: "open",
            },
          },
        },
        registerTool,
      }),
    );

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool.mock.calls[0]?.[1]).toEqual({
      name: "feishu_chat",
    });
    const tool = resolveRegisteredTool(registerTool);
    expect(tool?.name).toBe("feishu_chat");

    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { name: "group name", user_count: 3 },
    });
    const infoResult = await tool.execute("tc_1", { action: "info", chat_id: "oc_1" });
    expect(infoResult.details).toEqual({
      chat_id: "oc_1",
      name: "group name",
      description: undefined,
      owner_id: undefined,
      tenant_key: undefined,
      user_count: 3,
      chat_mode: undefined,
      chat_type: undefined,
      join_message_visibility: undefined,
      leave_message_visibility: undefined,
      membership_approval: undefined,
      moderation_permission: undefined,
      avatar: undefined,
    });

    chatMembersGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        page_token: "",
        items: [{ member_id: "ou_1", name: "member1", member_id_type: "open_id" }],
      },
    });
    const membersResult = await tool.execute("tc_2", { action: "members", chat_id: "oc_1" });
    expect(membersResult.details).toEqual({
      chat_id: "oc_1",
      has_more: false,
      page_token: "",
      members: [
        {
          member_id: "ou_1",
          name: "member1",
          tenant_key: undefined,
          member_id_type: "open_id",
        },
      ],
    });

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
    chatMembersGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        items: [{ member_id: "ou_1", name: "member1", member_id_type: "open_id" }],
      },
    });
    const memberInfoResult = await tool.execute("tc_3", {
      action: "member_info",
      member_id: "ou_1",
      chat_id: "oc_1",
    });
    expect(memberInfoResult.details).toEqual({
      member_id: "ou_1",
      member_id_type: "open_id",
      open_id: "ou_1",
      user_id: undefined,
      union_id: undefined,
      name: "member1",
      en_name: undefined,
      nickname: undefined,
      email: "member1@example.com",
      enterprise_email: undefined,
      mobile: undefined,
      mobile_visible: undefined,
      status: undefined,
      avatar: undefined,
      department_ids: ["od_1"],
      department_path: undefined,
      leader_user_id: undefined,
      city: undefined,
      country: undefined,
      work_station: undefined,
      join_time: undefined,
      is_tenant_manager: undefined,
      employee_no: undefined,
      employee_type: undefined,
      description: undefined,
      job_title: undefined,
      geo: undefined,
    });
  });

  it("allows current direct-chat reads under the default pairing policy", async () => {
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
              groupPolicy: "allowlist",
            },
          },
        },
        registerTool,
      }),
    );

    const tool = resolveRegisteredTool(registerTool, {
      deliveryTo: "user:ou_sender",
      nativeChannelId: "oc_direct_chat",
    });
    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { chat_mode: "p2p", chat_type: "private" },
    });

    const result = await tool.execute("tc_current_dm", {
      action: "info",
      chat_id: "oc_direct_chat",
    });

    expect(result.details).toMatchObject({
      chat_id: "oc_direct_chat",
      chat_mode: "p2p",
    });
  });

  it("returns the trusted sender for current direct-chat member reads", async () => {
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
              groupPolicy: "allowlist",
            },
          },
        },
        registerTool,
      }),
    );

    const tool = resolveRegisteredTool(registerTool, {
      deliveryTo: "user:ou_sender",
      nativeChannelId: "oc_direct_chat",
      requesterSenderId: "ou_sender",
    });
    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { chat_mode: "p2p", chat_type: "private" },
    });

    const result = await tool.execute("tc_current_dm_members", {
      action: "members",
      chat_id: "oc_direct_chat",
    });

    expect(result.details).toMatchObject({
      chat_id: "oc_direct_chat",
      has_more: false,
      members: [{ member_id: "ou_sender", member_id_type: "open_id" }],
    });
    expect(chatMembersGetMock).not.toHaveBeenCalled();
  });

  it("preserves a trusted user_id for current direct-chat member reads", async () => {
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
              groupPolicy: "allowlist",
            },
          },
        },
        registerTool,
      }),
    );

    const tool = resolveRegisteredTool(registerTool, {
      deliveryTo: "user:u_mobile_only",
      nativeChannelId: "oc_direct_chat",
      requesterSenderId: "u_mobile_only",
    });
    chatGetMock.mockResolvedValue({
      code: 0,
      data: { chat_mode: "p2p", chat_type: "private" },
    });
    contactUserGetMock.mockResolvedValueOnce({
      code: 0,
      data: { user: { user_id: "u_mobile_only", name: "Mobile User" } },
    });

    const members = await tool.execute("tc_current_dm_members_user_id", {
      action: "members",
      chat_id: "oc_direct_chat",
    });
    const profile = await tool.execute("tc_current_dm_profile_user_id", {
      action: "member_info",
      chat_id: "oc_direct_chat",
      member_id: "u_mobile_only",
    });

    expect(members.details).toMatchObject({
      members: [{ member_id: "u_mobile_only", member_id_type: "user_id" }],
    });
    expect(profile.details).toMatchObject({
      member_id: "u_mobile_only",
      member_id_type: "user_id",
    });
    expect(contactUserGetMock).toHaveBeenCalledWith({
      path: { user_id: "u_mobile_only" },
      params: {
        user_id_type: "user_id",
        department_id_type: "open_department_id",
      },
    });
  });

  it("rejects unrelated member profiles in current direct chats", async () => {
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
              groupPolicy: "allowlist",
            },
          },
        },
        registerTool,
      }),
    );

    const tool = resolveRegisteredTool(registerTool, {
      deliveryTo: "user:ou_sender",
      nativeChannelId: "oc_direct_chat",
      requesterSenderId: "ou_sender",
    });
    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { chat_mode: "p2p", chat_type: "private" },
    });

    const result = await tool.execute("tc_current_dm_other_member", {
      action: "member_info",
      chat_id: "oc_direct_chat",
      member_id: "ou_other",
    });

    expect(result.details.error).toContain("limited to the current sender");
    expect(contactUserGetMock).not.toHaveBeenCalled();
  });

  it.each(["info", "members", "member_info"] as const)(
    "rejects a blocked %s target before reading provider metadata",
    async (action) => {
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
                groupPolicy: "allowlist",
                groups: { oc_allowed: {}, oc_blocked: { enabled: false } },
              },
            },
          },
          registerTool,
        }),
      );
      const tool = resolveRegisteredTool(registerTool);
      const input = {
        action,
        chat_id: "oc_blocked",
        ...(action === "member_info" ? { member_id: "ou_member" } : {}),
      };

      const result = await tool.execute(`tc_blocked_${action}`, input);

      expect(result.details.error).toContain("Feishu read target is not allowed.");
      expect(chatGetMock).not.toHaveBeenCalled();
      expect(chatMembersGetMock).not.toHaveBeenCalled();
      expect(contactUserGetMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "an existing blocked direct chat",
      response: {
        code: 0,
        data: { chat_mode: "p2p", chat_type: "private" },
      },
    },
    {
      name: "a failed metadata lookup",
      response: {
        code: 230001,
        msg: "chat not found",
      },
    },
  ])("does not expose whether an ambiguous target is $name", async ({ response }) => {
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
              groupPolicy: "open",
            },
          },
        },
        registerTool,
      }),
    );
    const tool = resolveRegisteredTool(registerTool, {
      nativeChannelId: "oc_current",
    });
    chatGetMock.mockResolvedValueOnce(response);

    const result = await tool.execute("tc_ambiguous_target", {
      action: "info",
      chat_id: "oc_other",
    });

    expect(result.details.error).toContain("Feishu read target is not allowed.");
    expect(result.details.error).not.toContain("chat not found");
    expect(chatGetMock).toHaveBeenCalledOnce();
    expect(chatMembersGetMock).not.toHaveBeenCalled();
    expect(contactUserGetMock).not.toHaveBeenCalled();
  });

  it("lets a direct operator read an unconfigured group", async () => {
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
              groupPolicy: "allowlist",
            },
          },
        },
        registerTool,
      }),
    );
    const tool = resolveRegisteredTool(registerTool, {
      conversationReadOrigin: "direct-operator",
    });
    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { chat_mode: "group", name: "operator target" },
    });

    const result = await tool.execute("tc_direct_operator", {
      action: "info",
      chat_id: "oc_unconfigured",
    });

    expect(result.details).toMatchObject({
      chat_id: "oc_unconfigured",
      name: "operator target",
    });
  });

  it("routes chat reads through the contextual Feishu account", async () => {
    const registerTool = vi.fn();
    registerFeishuChatTools(
      createChatToolApi({
        config: {
          channels: {
            feishu: {
              defaultAccount: "a",
              accounts: {
                a: {
                  appId: "app_a",
                  appSecret: "secret_a", // pragma: allowlist secret
                  tools: { chat: true },
                  groupPolicy: "allowlist",
                },
                b: {
                  appId: "app_b",
                  appSecret: "secret_b", // pragma: allowlist secret
                  tools: { chat: true },
                  groupPolicy: "allowlist",
                },
              },
            },
          },
        },
        registerTool,
      }),
    );

    const tool = resolveRegisteredTool(registerTool, {
      agentAccountId: "b",
      deliveryAccountId: "b",
      nativeChannelId: "oc_1",
    });
    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { name: "account b chat" },
    });

    const result = await tool.execute("tc_account_b", {
      action: "info",
      chat_id: "oc_1",
    });

    expect(result.details).toMatchObject({
      chat_id: "oc_1",
      name: "account b chat",
    });
    expect(createFeishuClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "b" }),
    );
  });

  it("advertises and validates member page_size as a positive integer", async () => {
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
              groupPolicy: "open",
            },
          },
        },
        registerTool,
      }),
    );

    const tool = resolveRegisteredTool(registerTool);
    expect(tool?.parameters.properties.page_size).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 100,
    });

    chatMembersGetMock.mockResolvedValueOnce({
      code: 0,
      data: { has_more: false, items: [] },
    });
    await tool.execute("tc_page_size_string", {
      action: "members",
      chat_id: "oc_1",
      page_size: "25",
    });
    expect(chatMembersGetMock).toHaveBeenLastCalledWith({
      path: { chat_id: "oc_1" },
      params: {
        page_size: 25,
        page_token: undefined,
        member_id_type: "open_id",
      },
    });

    const invalidResult = await tool.execute("tc_page_size_invalid", {
      action: "members",
      chat_id: "oc_1",
      page_size: 0,
    });
    expect(invalidResult.details.error).toContain(
      "page_size must be a positive integer between 1 and 100",
    );
    expect(chatMembersGetMock).toHaveBeenCalledTimes(1);
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
              groupPolicy: "open",
            },
          },
        },
        registerTool,
      }),
    );

    const tool = resolveRegisteredTool(registerTool);
    chatMembersGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        items: [{ member_id: "ou_1", name: "member1", member_id_type: "open_id" }],
      },
    });
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
      chat_id: "oc_1",
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

  it("rejects repeated member-list page tokens", async () => {
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
              groupPolicy: "open",
            },
          },
        },
        registerTool,
      }),
    );

    const tool = resolveRegisteredTool(registerTool);
    chatMembersGetMock.mockResolvedValue({
      code: 0,
      data: {
        has_more: true,
        page_token: "same-token",
        items: [],
      },
    });

    const result = await tool.execute("tc_repeated_page", {
      action: "member_info",
      member_id: "ou_missing",
      chat_id: "oc_1",
    });

    expect(result.details.error).toContain("pagination repeated token");
    expect(chatMembersGetMock).toHaveBeenCalledTimes(2);
  });
});
