import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WhatsAppPollStore } from "./poll-durable-store.js";

describe("WhatsAppPollStore", () => {
  let dir: string;
  let store: WhatsAppPollStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-poll-store-"));
    store = new WhatsAppPollStore(dir);
  });

  afterEach(() => {
    store.close();
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

  it("does not resurrect an ownership row after it expires", () => {
    store.rememberOwnPollCreation("acct", "chat@lid", "POLL-3", -1);
    expect(store.isOwnPollCreation("acct", "chat@lid", "POLL-3")).toBe(false);
  });

  it("does not resurrect a creation message after it expires", () => {
    const message = { pollCreationMessage: { name: "q", options: [] } };
    store.rememberPollCreationMessage("acct", "chat@lid", "POLL-4", message, -1);
    expect(store.readPollCreationMessage("acct", "chat@lid", "POLL-4")).toBeUndefined();
  });

  it("scopes ownership and creation-message rows by account", () => {
    store.rememberOwnPollCreation("acct-a", "chat@lid", "POLL-5", 60_000);
    expect(store.isOwnPollCreation("acct-b", "chat@lid", "POLL-5")).toBe(false);
  });

  it("round-trips vote dedup and respects expiry", () => {
    expect(store.isVoteDedup("acct", "chat@lid", "VOTE-1")).toBe(false);
    store.rememberVoteDedup("acct", "chat@lid", "VOTE-1", 60_000);
    expect(store.isVoteDedup("acct", "chat@lid", "VOTE-1")).toBe(true);
    store.rememberVoteDedup("acct", "chat@lid", "VOTE-2", -1);
    expect(store.isVoteDedup("acct", "chat@lid", "VOTE-2")).toBe(false);
  });

  it("prunes only expired rows from both tables", () => {
    store.rememberOwnPollCreation("acct", "chat@lid", "POLL-KEEP", 60_000);
    store.rememberOwnPollCreation("acct", "chat@lid", "POLL-EXPIRED", -1);
    store.rememberVoteDedup("acct", "chat@lid", "VOTE-KEEP", 60_000);
    store.rememberVoteDedup("acct", "chat@lid", "VOTE-EXPIRED", -1);

    const pruned = store.pruneExpired();

    expect(pruned).toEqual({ creations: 1, votes: 1 });
    expect(store.isOwnPollCreation("acct", "chat@lid", "POLL-KEEP")).toBe(true);
    expect(store.isVoteDedup("acct", "chat@lid", "VOTE-KEEP")).toBe(true);
  });

  it("survives being reopened against the same directory (simulates a process restart)", () => {
    store.rememberOwnPollCreation("acct", "chat@lid", "POLL-RESTART", 60_000);
    const message = {
      pollCreationMessage: { name: "q", options: [{ optionName: "a" }] },
      messageContextInfo: { messageSecret: Buffer.from([9, 9, 9]) },
    };
    store.rememberPollCreationMessage("acct", "chat@lid", "POLL-RESTART", message, 60_000);
    store.close();

    const reopened = new WhatsAppPollStore(dir);
    store = reopened; // let afterEach close this one instead of the already-closed original
    expect(reopened.isOwnPollCreation("acct", "chat@lid", "POLL-RESTART")).toBe(true);
    const read = reopened.readPollCreationMessage("acct", "chat@lid", "POLL-RESTART");
    expect(Buffer.from(read!.messageContextInfo!.messageSecret as Uint8Array)).toEqual(
      Buffer.from([9, 9, 9]),
    );
  });
});
