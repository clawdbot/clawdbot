// Line tests cover directory adapter plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { linePlugin } from "./channel.js";

const directory = linePlugin.directory;
if (!directory?.listPeers || !directory.listGroups) {
  throw new Error("expected the LINE plugin to expose directory listPeers/listGroups");
}
const { listPeers, listGroups } = directory;
const runtime = createRuntimeEnv();

const alice = `U${"a".repeat(32)}`;
const bob = `U${"b".repeat(32)}`;
const carol = `U${"c".repeat(32)}`;
const dave = `U${"d".repeat(32)}`;
const erin = `U${"e".repeat(32)}`;
const group1 = `C${"1".repeat(32)}`;
const room1 = `R${"2".repeat(32)}`;
const group2 = `C${"3".repeat(32)}`;

const cfg = {
  accessGroups: { oncall: { type: "message.senders", members: { line: [carol] } } },
  channels: {
    line: {
      enabled: true,
      allowFrom: [alice, `line:user:${bob}`, "*", "accessGroup:oncall"],
      groupAllowFrom: [carol, alice],
      groups: {
        [group1]: { allowFrom: [dave] },
        [`room:${room1}`]: {},
        "*": { requireMention: false },
      },
      accounts: {
        support: {
          allowFrom: [erin],
          groups: { [group2]: {} },
        },
      },
    },
  },
} as unknown as OpenClawConfig;

describe("line directory adapter", () => {
  it("lists every sender the allowlists name", async () => {
    expect(await listPeers({ cfg, accountId: "default", runtime })).toEqual([
      { kind: "user", id: alice },
      { kind: "user", id: bob },
      { kind: "user", id: carol },
      { kind: "user", id: dave },
    ]);
  });

  // `*` and `accessGroup:<name>` authorize senders without naming a conversation, so
  // an exact match on either would hand outbound resolution an unsendable target.
  it("leaves out allowlist entries that are not addresses", async () => {
    const peers = await listPeers({ cfg, accountId: "default", runtime });
    expect(peers.map((entry) => entry.id)).not.toContain("*");
    expect(peers.map((entry) => entry.id)).not.toContain("accessGroup:oncall");
    expect(await listPeers({ cfg, accountId: "default", query: "accessGroup", runtime })).toEqual(
      [],
    );
  });

  it("lists a configured conversation under the id its messages carry", async () => {
    expect(await listGroups({ cfg, accountId: "default", runtime })).toEqual([
      { kind: "group", id: group1 },
      { kind: "group", id: room1 },
    ]);
  });

  // The listing has to agree with the ingress gate, which reads the same resolved
  // account: a key the account sets replaces the base one, a key it omits inherits.
  it("resolves an account the way the ingress gate does", async () => {
    expect(await listPeers({ cfg, accountId: "support", runtime })).toEqual([
      { kind: "user", id: erin },
      { kind: "user", id: carol },
      { kind: "user", id: alice },
    ]);
    expect(await listGroups({ cfg, accountId: "support", runtime })).toEqual([
      { kind: "group", id: group2 },
    ]);
  });

  it("filters and limits like the other channel directories", async () => {
    expect(await listPeers({ cfg, accountId: "default", query: "cccc", runtime })).toEqual([
      { kind: "user", id: carol },
    ]);
    expect(await listPeers({ cfg, accountId: "default", limit: 2, runtime })).toEqual([
      { kind: "user", id: alice },
      { kind: "user", id: bob },
    ]);
  });
});
