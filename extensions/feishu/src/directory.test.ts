// Feishu tests cover directory plugin behavior.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

const { listFeishuDirectoryGroupsLive, listFeishuDirectoryPeersLive } = await importFreshModule<
  typeof import("./directory.js")
>(import.meta.url, "./directory.js?directory-test");
const { listFeishuDirectoryGroups, listFeishuDirectoryPeers } = await importFreshModule<
  typeof import("./directory.static.js")
>(import.meta.url, "./directory.static.js?directory-test");
const { listAuthorizedFeishuDirectoryGroups, listAuthorizedFeishuDirectoryPeers } =
  await importFreshModule<typeof import("./directory.static.js")>(
    import.meta.url,
    "./directory.static.js?authorized-directory-test",
  );

function makeStaticCfg(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        allowFrom: ["user:alice", "user:bob"],
        dms: {
          "user:carla": {},
        },
        groups: {
          "chat-1": {},
        },
        groupAllowFrom: ["chat-2"],
      },
    },
  } as ClawdbotConfig;
}

function makeConfiguredCfg(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        ...makeStaticCfg().channels?.feishu,
        appId: "cli_test_app_id",
        appSecret: "cli_test_app_secret",
      },
    },
  } as ClawdbotConfig;
}

describe("feishu directory (config-backed)", () => {
  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    createFeishuClientMock.mockReset();
  });

  it("merges allowFrom + dms into peer entries", async () => {
    const peers = await listFeishuDirectoryPeers({ cfg: makeStaticCfg(), query: "a" });
    expect(peers).toEqual([
      { kind: "user", id: "alice" },
      { kind: "user", id: "carla" },
    ]);
  });

  it("normalizes spaced provider-prefixed peer entries", async () => {
    const cfg = {
      channels: {
        feishu: {
          allowFrom: [" feishu:user:ou_alice "],
          dms: {
            " lark:dm:ou_carla ": {},
          },
          groups: {},
          groupAllowFrom: [],
        },
      },
    } as ClawdbotConfig;

    const peers = await listFeishuDirectoryPeers({ cfg });
    expect(peers).toEqual([
      { kind: "user", id: "ou_alice" },
      { kind: "user", id: "ou_carla" },
    ]);
  });

  it("merges groups map + groupAllowFrom into group entries", async () => {
    const groups = await listFeishuDirectoryGroups({ cfg: makeStaticCfg() });
    expect(groups).toEqual([
      { kind: "group", id: "chat-1" },
      { kind: "group", id: "chat-2" },
    ]);
  });

  it("lists only read-authorized static peers and enabled groups", async () => {
    const cfg = makeStaticCfg();
    const feishu = cfg.channels?.feishu;
    if (!feishu) {
      throw new Error("Expected Feishu config");
    }
    feishu.groups = {
      ...feishu.groups,
      "chat-disabled": { enabled: false },
    };

    await expect(listAuthorizedFeishuDirectoryPeers({ cfg })).resolves.toEqual([
      { kind: "user", id: "alice" },
      { kind: "user", id: "bob" },
    ]);
    await expect(listAuthorizedFeishuDirectoryGroups({ cfg })).resolves.toEqual([
      { kind: "group", id: "chat-1" },
      { kind: "group", id: "chat-2" },
    ]);
  });

  it("keeps explicitly disabled groups out even when groupAllowFrom includes them", async () => {
    const cfg = makeStaticCfg();
    const feishu = cfg.channels?.feishu;
    if (!feishu) {
      throw new Error("Expected Feishu config");
    }
    feishu.groups = {
      ...feishu.groups,
      "chat-disabled": { enabled: false },
    };
    feishu.groupAllowFrom = [...(feishu.groupAllowFrom ?? []), "chat-disabled"];

    await expect(listAuthorizedFeishuDirectoryGroups({ cfg })).resolves.toEqual([
      { kind: "group", id: "chat-1" },
      { kind: "group", id: "chat-2" },
    ]);
  });

  it("applies the static group limit after authorization filtering", async () => {
    const cfg = {
      channels: {
        feishu: {
          groupPolicy: "allowlist",
          groups: {
            "chat-blocked": { enabled: false },
            "chat-allowed": {},
          },
        },
      },
    } as ClawdbotConfig;

    await expect(listAuthorizedFeishuDirectoryGroups({ cfg, limit: 1 })).resolves.toEqual([
      { kind: "group", id: "chat-allowed" },
    ]);
  });

  it("falls back to static peers on live lookup failure by default", async () => {
    createFeishuClientMock.mockReturnValueOnce({
      contact: {
        user: {
          list: vi.fn(async () => {
            throw new Error("token expired");
          }),
        },
      },
    });

    const peers = await listFeishuDirectoryPeersLive({ cfg: makeConfiguredCfg(), query: "a" });
    expect(peers).toEqual([
      { kind: "user", id: "alice" },
      { kind: "user", id: "carla" },
    ]);
  });

  it("paginates live groups until the filtered result limit is reached", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ chat_id: "chat-blocked", name: "Blocked" }],
          has_more: true,
          page_token: "page-2",
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ chat_id: "chat-allowed", name: "Allowed" }],
          has_more: false,
        },
      });
    createFeishuClientMock.mockReturnValueOnce({
      im: { chat: { list } },
    });

    await expect(
      listFeishuDirectoryGroupsLive({
        cfg: makeConfiguredCfg(),
        limit: 1,
        filter: (group) => group.id !== "chat-blocked",
      }),
    ).resolves.toEqual([{ kind: "group", id: "chat-allowed", name: "Allowed" }]);
    expect(list).toHaveBeenNthCalledWith(2, {
      params: {
        page_size: 1,
        page_token: "page-2",
      },
    });
  });

  it("rejects repeated live group directory page tokens", async () => {
    const list = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [{ chat_id: "chat-blocked", name: "Blocked" }],
        has_more: true,
        page_token: "repeat",
      },
    });
    createFeishuClientMock.mockReturnValueOnce({
      im: { chat: { list } },
    });

    await expect(
      listFeishuDirectoryGroupsLive({
        cfg: makeConfiguredCfg(),
        filter: () => false,
        fallbackToStatic: false,
      }),
    ).rejects.toThrow("Feishu live group directory returned a repeated page token");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("surfaces live peer lookup failures when fallback is disabled", async () => {
    createFeishuClientMock.mockReturnValueOnce({
      contact: {
        user: {
          list: vi.fn(async () => {
            throw new Error("token expired");
          }),
        },
      },
    });

    await expect(
      listFeishuDirectoryPeersLive({ cfg: makeConfiguredCfg(), fallbackToStatic: false }),
    ).rejects.toThrow("token expired");
  });

  it("surfaces live group lookup failures when fallback is disabled", async () => {
    createFeishuClientMock.mockReturnValueOnce({
      im: {
        chat: {
          list: vi.fn(async () => ({ code: 999, msg: "forbidden" })),
        },
      },
    });

    await expect(
      listFeishuDirectoryGroupsLive({ cfg: makeConfiguredCfg(), fallbackToStatic: false }),
    ).rejects.toThrow("forbidden");
  });
});
