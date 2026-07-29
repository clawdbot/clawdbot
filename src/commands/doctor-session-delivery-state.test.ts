import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { repairCanonicalSessionDeliveryStates } from "./doctor-session-delivery-state.js";

const tempDirs = createTempDirTracker();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  tempDirs.cleanup();
});

function insertSessionRow(
  env: NodeJS.ProcessEnv,
  sessionKey: string,
  entry: Record<string, unknown>,
): void {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(sessionKey, String(entry.sessionId), JSON.stringify(entry), Number(entry.updatedAt));
  const legacyContext = entry.deliveryContext as Record<string, unknown> | undefined;
  database.db
    .prepare(
      "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at, channel, account_id) VALUES (?, ?, 'conversation', ?, ?, ?, ?)",
    )
    .run(
      String(entry.sessionId),
      sessionKey,
      Number(entry.updatedAt),
      Number(entry.updatedAt),
      typeof entry.channel === "string"
        ? entry.channel
        : typeof legacyContext?.channel === "string"
          ? legacyContext.channel
          : null,
      typeof entry.lastAccountId === "string"
        ? entry.lastAccountId
        : typeof legacyContext?.accountId === "string"
          ? legacyContext.accountId
          : null,
    );
}

function readEntryJson(env: NodeJS.ProcessEnv, sessionKey: string): string {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const row = database.db
    .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
    .get(sessionKey) as { entry_json: string };
  return row.entry_json;
}

describe("doctor canonical session delivery state", () => {
  it("keeps bare channel and origin metadata below explicit delivery context", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-delivery-fallback-order-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    insertSessionRow(env, "agent:main:explicit", {
      sessionId: "explicit-session",
      updatedAt: 10,
      channel: "slack",
      deliveryContext: { channel: "telegram", to: "current", accountId: "current-bot" },
      origin: { provider: "discord", to: "stale", accountId: "stale-bot" },
    });
    insertSessionRow(env, "agent:main:origin-only", {
      sessionId: "origin-session",
      updatedAt: 20,
      origin: { provider: "discord", to: "origin-recipient", accountId: "origin-bot" },
    });
    insertSessionRow(env, "agent:main:orphan-account", {
      sessionId: "orphan-account-session",
      updatedAt: 30,
      channel: "slack",
      deliveryContext: { channel: "telegram", to: "current", accountId: "current-bot" },
      lastAccountId: "stale-slack-bot",
    });
    insertSessionRow(env, "agent:main:whitespace-last", {
      sessionId: "whitespace-last-session",
      updatedAt: 40,
      channel: "slack",
      deliveryContext: { channel: "telegram", to: "current", accountId: "current-bot" },
      lastTo: "   ",
    });

    expect(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env })).toEqual({
      found: 4,
      repaired: 4,
      scannedStores: 1,
    });
    expect(JSON.parse(readEntryJson(env, "agent:main:explicit")).delivery.context).toEqual({
      channel: "telegram",
      to: "current",
      accountId: "current-bot",
    });
    expect(JSON.parse(readEntryJson(env, "agent:main:origin-only")).delivery.context).toEqual({
      channel: "discord",
      to: "origin-recipient",
      accountId: "origin-bot",
    });
    for (const key of ["agent:main:orphan-account", "agent:main:whitespace-last"]) {
      expect(JSON.parse(readEntryJson(env, key)).delivery.context).toEqual({
        channel: "telegram",
        to: "current",
        accountId: "current-bot",
      });
    }
  });

  it("preserves shipped last-route precedence over stale explicit context", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-delivery-precedence-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    insertSessionRow(env, "agent:main:precedence", {
      sessionId: "precedence-session",
      updatedAt: 10,
      deliveryContext: { channel: "telegram", to: "old-recipient", accountId: "bot" },
      lastChannel: "telegram",
      lastTo: "new-recipient",
      lastAccountId: "bot",
    });
    insertSessionRow(env, "agent:main:partial-precedence", {
      sessionId: "partial-precedence-session",
      updatedAt: 20,
      channel: "slack",
      lastChannel: "",
      deliveryContext: { channel: "telegram", to: "old-recipient" },
      lastTo: "C-new",
    });

    expect(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env })).toEqual({
      found: 2,
      repaired: 2,
      scannedStores: 1,
    });
    expect(JSON.parse(readEntryJson(env, "agent:main:precedence")).delivery.context).toEqual({
      channel: "telegram",
      to: "new-recipient",
      accountId: "bot",
    });
    expect(
      JSON.parse(readEntryJson(env, "agent:main:partial-precedence")).delivery.context,
    ).toEqual({
      channel: "slack",
      to: "C-new",
    });
  });

  it("recovers a legacy route after an unrelated runtime write stamps delivery none", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-delivery-none-stamp-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    insertSessionRow(env, "agent:main:stamped-none", {
      sessionId: "stamped-none-session",
      updatedAt: 10,
      delivery: { kind: "none" },
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "bot",
    });

    expect(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env })).toEqual({
      found: 1,
      repaired: 1,
      scannedStores: 1,
    });
    expect(JSON.parse(readEntryJson(env, "agent:main:stamped-none")).delivery).toMatchObject({
      kind: "external",
      context: { channel: "telegram", to: "-100123", accountId: "bot" },
    });
  });

  it("preserves explicit legacy channel ownership without a recipient", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-delivery-channel-only-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    insertSessionRow(env, "agent:main:channel-only", {
      sessionId: "channel-only-session",
      updatedAt: 10,
      lastChannel: "slack",
      lastAccountId: "work",
    });

    expect(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env })).toEqual({
      found: 1,
      repaired: 1,
      scannedStores: 1,
    });
    expect(JSON.parse(readEntryJson(env, "agent:main:channel-only")).delivery).toMatchObject({
      kind: "external",
      context: { channel: "slack", accountId: "work" },
    });
  });

  it("recovers an external legacy route after an internal transition stamp", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-delivery-internal-stamp-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    insertSessionRow(env, "agent:main:stamped-internal", {
      sessionId: "stamped-internal-session",
      updatedAt: 10,
      delivery: { kind: "internal" },
      lastChannel: "telegram",
      lastTo: "-100456",
      lastAccountId: "bot",
    });

    expect(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env })).toEqual({
      found: 1,
      repaired: 1,
      scannedStores: 1,
    });
    expect(JSON.parse(readEntryJson(env, "agent:main:stamped-internal")).delivery).toMatchObject({
      kind: "external",
      context: { channel: "telegram", to: "-100456", accountId: "bot" },
    });
  });

  it("promotes legacy internal origin chat type before removing origin", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-delivery-internal-chat-type-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    insertSessionRow(env, "agent:main:internal-chat", {
      sessionId: "internal-chat-session",
      updatedAt: 10,
      channel: "webchat",
      origin: { provider: "webchat", chatType: "direct" },
    });

    expect(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env })).toEqual({
      found: 1,
      repaired: 1,
      scannedStores: 1,
    });
    expect(JSON.parse(readEntryJson(env, "agent:main:internal-chat"))).toMatchObject({
      chatType: "direct",
      delivery: { kind: "internal" },
    });
  });

  it("skips structurally invalid row JSON while repairing valid sessions", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-delivery-invalid-row-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    insertSessionRow(env, "agent:main:legacy", {
      sessionId: "legacy-session",
      updatedAt: 10,
      deliveryContext: { channel: "telegram", to: "-1001" },
    });
    openOpenClawAgentDatabase({ agentId: "main", env })
      .db.prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("agent:main:invalid", "invalid-session", "null", 20);

    expect(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env })).toEqual({
      found: 1,
      repaired: 1,
      scannedStores: 1,
    });
    expect(readEntryJson(env, "agent:main:invalid")).toBe("null");
  });

  it("migrates a copied realistic store without touching the source or canonical row bytes", () => {
    const sourceStateDir = fs.realpathSync(tempDirs.make("openclaw-delivery-source-"));
    const sourceEnv = { ...process.env, OPENCLAW_STATE_DIR: sourceStateDir };
    const canonicalEntry = {
      sessionId: "canonical-session",
      updatedAt: 30,
      delivery: {
        kind: "external",
        route: { channel: "telegram", target: { to: "-1002" } },
        context: { channel: "telegram", to: "-1002" },
        origin: { provider: "telegram", to: "-1002" },
      },
    };
    insertSessionRow(sourceEnv, "agent:main:legacy", {
      sessionId: "legacy-session",
      updatedAt: 10,
      route: {
        channel: "webchat",
        accountId: "work",
        target: { to: "session:dashboard" },
        thread: { id: "thread-1" },
      },
      deliveryContext: { channel: "telegram", to: "-1001" },
      origin: {
        provider: "telegram",
        to: "-1001",
        chatType: "group",
        accountId: "work",
        threadId: "thread-1",
      },
      channel: "webchat",
      lastChannel: "webchat",
      lastTo: "session:dashboard",
      lastAccountId: "work",
      lastThreadId: "thread-1",
    });
    insertSessionRow(sourceEnv, "agent:main:internal", {
      sessionId: "internal-session",
      updatedAt: 20,
      channel: "webchat",
      lastChannel: "webchat",
      lastTo: "session:control",
    });
    insertSessionRow(sourceEnv, "agent:main:origin-stale", {
      sessionId: "origin-stale-session",
      updatedAt: 25,
      deliveryContext: { channel: "telegram", to: "current-recipient" },
      origin: { provider: "telegram", to: "stale-recipient", accountId: "bot" },
      lastChannel: "webchat",
      lastAccountId: "bot",
      lastThreadId: "topic-1",
    });
    insertSessionRow(sourceEnv, "agent:main:canonical", canonicalEntry);
    const canonicalJson = JSON.stringify(canonicalEntry);
    const sourceLegacyJson = readEntryJson(sourceEnv, "agent:main:legacy");
    const sourcePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: sourceEnv });
    closeOpenClawAgentDatabasesForTest();

    const copiedStateDir = fs.realpathSync(tempDirs.make("openclaw-delivery-copy-"));
    const copiedEnv = { ...process.env, OPENCLAW_STATE_DIR: copiedStateDir };
    const copiedPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: copiedEnv });
    fs.mkdirSync(path.dirname(copiedPath), { recursive: true });
    fs.copyFileSync(sourcePath, copiedPath);

    expect(repairCanonicalSessionDeliveryStates({ apply: false, cfg: {}, env: copiedEnv })).toEqual(
      {
        found: 3,
        repaired: 0,
        scannedStores: 1,
      },
    );
    expect(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env: copiedEnv })).toEqual({
      found: 3,
      repaired: 3,
      scannedStores: 1,
    });
    expect(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env: copiedEnv })).toEqual({
      found: 0,
      repaired: 0,
      scannedStores: 1,
    });

    const migrated = JSON.parse(readEntryJson(copiedEnv, "agent:main:legacy")) as Record<
      string,
      unknown
    >;
    expect(migrated.delivery).toEqual({
      kind: "external",
      route: {
        channel: "telegram",
        accountId: "work",
        target: { to: "-1001" },
        thread: { id: "thread-1" },
      },
      context: {
        channel: "telegram",
        to: "-1001",
        accountId: "work",
        threadId: "thread-1",
      },
      origin: {
        provider: "telegram",
        to: "-1001",
        chatType: "group",
        accountId: "work",
        threadId: "thread-1",
      },
    });
    for (const key of [
      "route",
      "deliveryContext",
      "origin",
      "channel",
      "lastChannel",
      "lastTo",
      "lastAccountId",
      "lastThreadId",
    ]) {
      expect(migrated).not.toHaveProperty(key);
    }
    expect(JSON.parse(readEntryJson(copiedEnv, "agent:main:internal")).delivery).toEqual({
      kind: "internal",
    });
    expect(
      JSON.parse(readEntryJson(copiedEnv, "agent:main:origin-stale")).delivery.context,
    ).toMatchObject({
      channel: "telegram",
      to: "current-recipient",
      accountId: "bot",
      threadId: "topic-1",
    });
    expect(readEntryJson(copiedEnv, "agent:main:canonical")).toBe(canonicalJson);
    expect(
      openOpenClawAgentDatabase({ agentId: "main", env: copiedEnv })
        .db.prepare("SELECT channel, account_id FROM session_windows WHERE session_id = ?")
        .get("legacy-session"),
    ).toEqual({ channel: "telegram", account_id: "work" });

    closeOpenClawAgentDatabasesForTest();
    expect(readEntryJson(sourceEnv, "agent:main:legacy")).toBe(sourceLegacyJson);
  });
});
