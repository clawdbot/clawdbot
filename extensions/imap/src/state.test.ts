import { describe, expect, it } from "vitest";
import { resolveImapConfig } from "./config.js";
import { createImapTestRuntime } from "./imap-test-support.js";
import {
  advanceImapCursor,
  countImapSkip,
  initializeImapCursor,
  recordImapAttempt,
  rememberImapMessage,
} from "./state.js";

describe("IMAP durable watcher state", () => {
  it("keeps healthy accounts available when a sibling SecretRef could not resolve", () => {
    const config = resolveImapConfig({
      accounts: {
        healthy: {
          host: "imap.example.com",
          user: "reader@example.com",
          password: "resolved-password",
          agentId: "mail_reader",
        },
        unavailable: {
          host: "imap.example.com",
          user: "reader@example.com",
          password: { source: "env", provider: "default", id: "MISSING_IMAP_PASSWORD" },
          agentId: "mail_reader",
        },
      },
    });
    expect(Object.keys(config.accounts)).toEqual(["healthy"]);
  });

  it("baselines existing mail, resumes its cursor, and resets after UIDVALIDITY changes", async () => {
    const { state } = createImapTestRuntime();
    expect(await initializeImapCursor(state, "account", "17", 42)).toMatchObject({
      kind: "baseline",
      cursor: { uidValidity: "17", lastSeenUid: 41 },
    });
    await advanceImapCursor(state, "account", "17", 45);
    expect(await initializeImapCursor(state, "account", "17", 46)).toMatchObject({
      kind: "resume",
      cursor: { lastSeenUid: 45 },
    });
    expect(await initializeImapCursor(state, "account", "18", 8)).toMatchObject({
      kind: "reset",
      cursor: { uidValidity: "18", lastSeenUid: 7 },
    });
  });

  it("deduplicates claims and logical Message-IDs without growing the account ring", async () => {
    const { state } = createImapTestRuntime();
    const claim = { accountId: "account", uid: 1, recordedAt: 0 };
    expect(await state.claims.registerIfAbsent("account:17:1", claim)).toBe(true);
    expect(await state.claims.registerIfAbsent("account:17:1", claim)).toBe(false);
    for (let index = 0; index < 101; index++) {
      expect(await rememberImapMessage(state, "account", `<${index}@example.com>`)).toBe(true);
    }
    expect(await rememberImapMessage(state, "account", "<100@example.com>")).toBe(false);
    expect((await state.messageIds.lookup("account"))?.messageIds).toHaveLength(100);
  });

  it("records bounded retries separately from final account skip counters", async () => {
    const { state } = createImapTestRuntime();
    expect(await recordImapAttempt(state, "account:17:2", "temperror")).toBe(1);
    expect(await recordImapAttempt(state, "account:17:2", "temperror")).toBe(2);
    await countImapSkip(state, "account", "temperror");
    await countImapSkip(state, "account", "temperror");
    expect(await state.skips.lookup("account:temperror")).toEqual({ count: 2 });
  });
});
