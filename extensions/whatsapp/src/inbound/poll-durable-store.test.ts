import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WhatsAppPollStore } from "./poll-durable-store.js";

describe("WhatsAppPollStore", () => {
  let dir: string;
  let store: WhatsAppPollStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-poll-store-"));
    store = new WhatsAppPollStore({ ...process.env, OPENCLAW_STATE_DIR: dir });
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips poll ownership independent of the creation message", () => {
    expect(store.isOwnPollCreation("acct", "chat@lid", "POLL-1")).toBe(false);
    store.rememberOwnPollCreation("acct", "chat@lid", "POLL-1", 60_000);
    expect(store.isOwnPollCreation("acct", "chat@lid", "POLL-1")).toBe(true);
    // No creation message recorded yet — ownership alone doesn't fabricate one.
    expect(store.readPollCreationMessage("acct", "chat@lid", "POLL-1")).toBeUndefined();
  });

  it("round-trips the poll creation message, including a Buffer secret", () => {
    const message = {
      pollCreationMessage: { name: "q", options: [{ optionName: "a" }] },
      messageContextInfo: { messageSecret: Buffer.from([1, 2, 3, 4]) },
    };
    store.rememberPollCreationMessage("acct", "chat@lid", "POLL-2", message, 60_000);
    const read = store.readPollCreationMessage("acct", "chat@lid", "POLL-2");
    expect(read?.pollCreationMessage?.name).toBe("q");
    expect(Buffer.from(read!.messageContextInfo!.messageSecret as Uint8Array)).toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
  });

  it("does not resurrect an ownership entry after it expires", async () => {
    store.rememberOwnPollCreation("acct", "chat@lid", "POLL-3", 1);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(store.isOwnPollCreation("acct", "chat@lid", "POLL-3")).toBe(false);
  });

  it("does not resurrect a creation message after it expires", async () => {
    const message = { pollCreationMessage: { name: "q", options: [] } };
    store.rememberPollCreationMessage("acct", "chat@lid", "POLL-4", message, 1);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(store.readPollCreationMessage("acct", "chat@lid", "POLL-4")).toBeUndefined();
  });

  it("scopes ownership and creation-message entries by account", () => {
    store.rememberOwnPollCreation("acct-a", "chat@lid", "POLL-5", 60_000);
    expect(store.isOwnPollCreation("acct-b", "chat@lid", "POLL-5")).toBe(false);
  });

  it("round-trips vote dedup and respects expiry", async () => {
    expect(store.isVoteDedup("acct", "chat@lid", "VOTE-1")).toBe(false);
    store.rememberVoteDedup("acct", "chat@lid", "VOTE-1", 60_000);
    expect(store.isVoteDedup("acct", "chat@lid", "VOTE-1")).toBe(true);
    store.rememberVoteDedup("acct", "chat@lid", "VOTE-2", 1);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(store.isVoteDedup("acct", "chat@lid", "VOTE-2")).toBe(false);
  });

  it("does not extend expiry when ownership is rewritten by a delayed/replayed self-echo", async () => {
    // Regression: update() used to pass the full ttlMs on every write, so a
    // delayed messages.upsert echo of the same poll creation (WhatsApp
    // redelivering after a reconnect, e.g.) reset the expiry clock to "now"
    // instead of leaving it anchored to the original write.
    store.rememberOwnPollCreation("acct", "chat@lid", "POLL-ANCHOR-OWN", 150);
    await new Promise((resolve) => {
      setTimeout(resolve, 80);
    });
    // Replays the same write, as a delayed self-echo would.
    store.rememberOwnPollCreation("acct", "chat@lid", "POLL-ANCHOR-OWN", 150);
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    // 180ms since the original write: past its 150ms anchor. A naive
    // full-ttl-refresh on the replay would still consider this alive
    // (80ms + 150ms = 230ms), so this only passes with anchoring fixed.
    expect(store.isOwnPollCreation("acct", "chat@lid", "POLL-ANCHOR-OWN")).toBe(false);
  });

  it("does not extend expiry when the creation message is rewritten by a delayed/replayed self-echo", async () => {
    const message = { pollCreationMessage: { name: "q", options: [] } };
    store.rememberPollCreationMessage("acct", "chat@lid", "POLL-ANCHOR-MSG", message, 150);
    await new Promise((resolve) => {
      setTimeout(resolve, 80);
    });
    store.rememberPollCreationMessage("acct", "chat@lid", "POLL-ANCHOR-MSG", message, 150);
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(store.readPollCreationMessage("acct", "chat@lid", "POLL-ANCHOR-MSG")).toBeUndefined();
  });

  it("survives being reopened against the same state dir (simulates a process restart)", () => {
    store.rememberOwnPollCreation("acct", "chat@lid", "POLL-RESTART", 60_000);
    const message = {
      pollCreationMessage: { name: "q", options: [{ optionName: "a" }] },
      messageContextInfo: { messageSecret: Buffer.from([9, 9, 9]) },
    };
    store.rememberPollCreationMessage("acct", "chat@lid", "POLL-RESTART", message, 60_000);

    const reopened = new WhatsAppPollStore({ ...process.env, OPENCLAW_STATE_DIR: dir });
    expect(reopened.isOwnPollCreation("acct", "chat@lid", "POLL-RESTART")).toBe(true);
    const read = reopened.readPollCreationMessage("acct", "chat@lid", "POLL-RESTART");
    expect(Buffer.from(read!.messageContextInfo!.messageSecret as Uint8Array)).toEqual(
      Buffer.from([9, 9, 9]),
    );
  });
});
