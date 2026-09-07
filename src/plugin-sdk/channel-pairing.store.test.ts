import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveChannelPairingCode,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  removeChannelAllowFromStoreEntry,
  upsertChannelPairingRequest,
} from "../pairing/pairing-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createPluginRuntimeMock } from "./test-helpers/plugin-runtime-mock.js";

let stateDir: string;
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function createPairingFixture() {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-scoped-pairing-"));
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const core = createPluginRuntimeMock({
    channel: {
      pairing: {
        upsertPairingRequest: (input) => upsertChannelPairingRequest({ ...input, env }),
        readAllowFromStore: ({ channel, accountId }) =>
          readChannelAllowFromStore(channel, env, accountId),
        removeAllowFromStoreEntry: (input) => removeChannelAllowFromStoreEntry({ ...input, env }),
      },
    },
  });
  return {
    env,
    pairing: createChannelPairingController({ core, channel: "demo", accountId: " Alpha " }),
  };
}

describe("channel pairing account isolation", () => {
  it.each([
    { name: "ordinary input", extras: {} },
    { name: "conflicting account", extras: { accountId: "beta" } },
    { name: "conflicting channel and account", extras: { channel: "other", accountId: "beta" } },
  ])("persists and approves $name only in the bound account", async ({ extras }) => {
    const { env, pairing } = createPairingFixture();
    const beta = await upsertChannelPairingRequest({
      channel: "demo",
      accountId: "beta",
      id: "shared-sender",
      meta: { name: "Beta sender" },
      env,
    });
    const request = { id: "shared-sender", meta: { name: "Alpha sender" }, ...extras };
    const alpha = await pairing.upsertPairingRequest(request);
    expect(alpha.created).toBe(true);
    expect(alpha.code).not.toBe(beta.code);
    await expect(pairing.upsertPairingRequest(request)).resolves.toEqual({
      code: alpha.code,
      created: false,
    });
    closeOpenClawStateDatabaseForTest();
    await expect(listChannelPairingRequests("demo", env, "alpha")).resolves.toMatchObject([
      { id: "shared-sender", code: alpha.code, meta: { name: "Alpha sender", accountId: "alpha" } },
    ]);
    await expect(listChannelPairingRequests("demo", env, "beta")).resolves.toMatchObject([
      { code: beta.code, meta: { name: "Beta sender", accountId: "beta" } },
    ]);
    await expect(listChannelPairingRequests("other", env, "beta")).resolves.toEqual([]);
    await expect(
      approveChannelPairingCode({ channel: "demo", accountId: "beta", code: alpha.code, env }),
    ).resolves.toBeNull();
    await expect(
      approveChannelPairingCode({ channel: "demo", accountId: "alpha", code: alpha.code, env }),
    ).resolves.toMatchObject({ id: "shared-sender" });
    await expect(pairing.readAllowFromStore()).resolves.toEqual(["shared-sender"]);
    await expect(listChannelPairingRequests("demo", env, "alpha")).resolves.toEqual([]);
    await expect(readChannelAllowFromStore("demo", env, "beta")).resolves.toEqual([]);

    await approveChannelPairingCode({ channel: "demo", accountId: "beta", code: beta.code, env });
    await expect(pairing.removeAllowFromStoreEntry("shared-sender")).resolves.toEqual({
      changed: true,
      allowFrom: [],
    });
    await expect(pairing.readAllowFromStore()).resolves.toEqual([]);
    await expect(pairing.readStoreForDmPolicy("demo", " Beta ")).resolves.toEqual([
      "shared-sender",
    ]);
  });

  it("keeps challenge persistence and approval replies bound despite a replacement writer", async () => {
    const { env, pairing } = createPairingFixture();
    const replies: string[] = [];
    const challenge = {
      senderId: "challenge-sender",
      senderIdLine: "Sender: challenge-sender",
      meta: { name: "Challenge sender" },
      sendPairingReply: async (text: string) => {
        replies.push(text);
      },
      channel: "other",
      accountId: "beta",
      upsertPairingRequest: () =>
        upsertChannelPairingRequest({
          channel: "other",
          accountId: "beta",
          id: "replacement-sender",
          env,
        }),
    };
    const result = await pairing.issueChallenge(challenge);
    const [stored] = await listChannelPairingRequests("demo", env, "alpha");
    assert.ok(stored);
    expect(stored).toMatchObject({
      id: "challenge-sender",
      code: result.code,
      meta: { name: "Challenge sender", accountId: "alpha" },
    });
    await expect(listChannelPairingRequests("other", env, "beta")).resolves.toEqual([]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(`openclaw pairing approve demo ${stored.code}`);
    await expect(pairing.issueChallenge(challenge)).resolves.toEqual({ created: false });
    expect(replies).toHaveLength(1);
    await expect(
      approveChannelPairingCode({ channel: "demo", accountId: "alpha", code: stored.code, env }),
    ).resolves.toMatchObject({ id: "challenge-sender" });
    await expect(pairing.readAllowFromStore()).resolves.toEqual(["challenge-sender"]);
  });
});
