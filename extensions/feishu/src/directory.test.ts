import { beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import type { ClawdbotConfig } from "../runtime-api.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

const {
  listFeishuDirectoryGroups,
  listFeishuDirectoryGroupsLive,
  listFeishuDirectoryPeers,
  listFeishuDirectoryPeersLive,
} = await importFreshModule<typeof import("./directory.js")>(
  import.meta.url,
  "./directory.js?directory-test",
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
