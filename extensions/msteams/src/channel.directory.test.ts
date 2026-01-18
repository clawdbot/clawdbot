import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

import { msteamsPlugin } from "./channel.js";

describe("msteams directory", () => {
  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        msteams: {
          allowFrom: ["alice", "user:Bob"],
          dms: { carol: {}, bob: {} },
          teams: {
            team1: {
              channels: {
                "conversation:chan1": {},
                chan2: {},
              },
            },
          },
        },
      },
    } as unknown as ClawdbotConfig;

    expect(msteamsPlugin.directory).toBeTruthy();
    expect(msteamsPlugin.directory?.listPeers).toBeTruthy();
    expect(msteamsPlugin.directory?.listGroups).toBeTruthy();

    await expect(msteamsPlugin.directory!.listPeers({ cfg, query: undefined, limit: undefined })).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "user:alice" },
        { kind: "user", id: "user:Bob" },
        { kind: "user", id: "user:carol" },
        { kind: "user", id: "user:bob" },
      ]),
    );

    await expect(msteamsPlugin.directory!.listGroups({ cfg, query: undefined, limit: undefined })).resolves.toEqual(
      expect.arrayContaining([
        { kind: "group", id: "conversation:chan1" },
        { kind: "group", id: "conversation:chan2" },
      ]),
    );
  });
});
