import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { linePlugin } from "../channel-plugin-api.js";

const directory = linePlugin.directory;
if (!directory?.listPeers || !directory.listGroups) {
  throw new Error("LINE directory callbacks are missing");
}
const { listPeers, listGroups } = directory;
const runtime = createRuntimeEnv();
const user = `U${"1".repeat(32)}`;
const groupSender = `U${"2".repeat(32)}`;
const roomSender = `U${"3".repeat(32)}`;
const accountUser = `U${"4".repeat(32)}`;
const group = `C${"5".repeat(32)}`;
const room = `R${"6".repeat(32)}`;
const accountGroup = `C${"7".repeat(32)}`;
const cfg: OpenClawConfig = {
  channels: {
    line: {
      allowFrom: [user, `line:user:${user}`, "*", "accessGroup:operators"],
      groupAllowFrom: [groupSender, user],
      groups: {
        [`group:${group}`]: { allowFrom: [roomSender] },
        [group]: {},
        [`room:${room}`]: {},
        "*": { requireMention: false },
      },
      accounts: { support: { allowFrom: [accountUser], groups: { [accountGroup]: {} } } },
    },
  },
};

describe("LINE configured directory", () => {
  it("lists unique sendable users from all configured sender scopes", async () => {
    expect(await listPeers({ cfg, accountId: "default", runtime })).toEqual([
      { kind: "user", id: user },
      { kind: "user", id: groupSender },
      { kind: "user", id: roomSender },
    ]);
  });

  it("lists group and room IDs after config-key normalization", async () => {
    expect(await listGroups({ cfg, accountId: "default", runtime })).toEqual([
      { kind: "group", id: group },
      { kind: "group", id: room },
    ]);
  });

  it("uses account overrides and inherits omitted sender scopes", async () => {
    expect(await listPeers({ cfg, accountId: "support", runtime })).toEqual([
      { kind: "user", id: accountUser },
      { kind: "user", id: groupSender },
      { kind: "user", id: user },
    ]);
    expect(await listGroups({ cfg, accountId: "support", runtime })).toEqual([
      { kind: "group", id: accountGroup },
    ]);
  });

  it("filters normalized IDs before applying the directory limit", async () => {
    expect(
      await listPeers({ cfg, accountId: "default", query: "U2222", limit: 1, runtime }),
    ).toEqual([{ kind: "user", id: groupSender }]);
    expect(await listPeers({ cfg, accountId: "default", limit: 1, runtime })).toEqual([
      { kind: "user", id: user },
    ]);
    expect(await listGroups({ cfg, accountId: "default", query: "R6666", runtime })).toEqual([
      { kind: "group", id: room },
    ]);
  });

  it("leaves an unconfigured directory empty and self identity unavailable", async () => {
    expect(await listPeers({ cfg: {}, runtime })).toEqual([]);
    expect(await listGroups({ cfg: {}, runtime })).toEqual([]);
    expect(await directory.self?.({ cfg, runtime })).toBeNull();
  });
});
