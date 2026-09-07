import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatContextFromIMessageTarget } from "./chat-context.js";
import { checkIMessageResourceBinding } from "./message-resource-db.js";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

type MessageResourceModule = typeof import("./message-resource.js");
type ReplyCacheModule = typeof import("./monitor-reply-cache.js");
let authorizeIMessageResourceReference: MessageResourceModule["authorizeIMessageResourceReference"];
let rememberIMessageReplyCache: ReplyCacheModule["rememberIMessageReplyCache"];
let resolveIMessageCachedResourceBinding: ReplyCacheModule["resolveIMessageCachedResourceBinding"];

let tempDir = "";
let dbPath = "";
let cliPath = "";

beforeEach(async () => {
  ({ rememberIMessageReplyCache, resolveIMessageCachedResourceBinding } =
    await loadFreshIMessageReplyCacheForTest());
  ({ authorizeIMessageResourceReference } = await import("./message-resource.js"));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imessage-resource-"));
  dbPath = path.join(tempDir, "chat.db");
  const binDir = path.join(tempDir, "bin");
  const libexecDir = path.join(tempDir, "libexec");
  const binaryPath = path.join(libexecDir, "imsg");
  cliPath = path.join(binDir, "imsg");
  fs.mkdirSync(binDir);
  fs.mkdirSync(libexecDir);
  fs.writeFileSync(binaryPath, Buffer.from("cafebabe", "hex"));
  fs.writeFileSync(cliPath, `#!/bin/bash\nexec "${binaryPath}" "$@"\n`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, guid TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO chat(ROWID, chat_identifier, guid) VALUES
      (1, '+15550001111', 'iMessage;-;+15550001111'),
      (2, 'other', 'iMessage;+;Some@example.com'),
      (3, '+15550002222', 'SMS;-;+15550002222'),
      (4, 'Üser@Example.com', 'iMessage;-;Üser@Example.com');
    INSERT INTO message(ROWID, guid) VALUES
      (10, 'message-guid'),
      (11, 'sms-message-guid'),
      (12, 'email-message-guid'),
      (13, 'other-message-guid');
    INSERT INTO chat_message_join(chat_id, message_id) VALUES
      (1, 10),
      (3, 11),
      (4, 12),
      (2, 13);
  `);
  db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("iMessage provider resource binding", () => {
  it("only treats canonical handles as authoritative chat identifiers", () => {
    expect(
      chatContextFromIMessageTarget({ kind: "handle", to: "Jane Appleseed", service: "auto" }),
    ).toEqual({});
    expect(
      chatContextFromIMessageTarget({ kind: "handle", to: "206 555 0100", service: "auto" }),
    ).toEqual({});
    expect(
      chatContextFromIMessageTarget({ kind: "handle", to: "+1 (206) 555-0100", service: "auto" }),
    ).toEqual({});
    expect(
      chatContextFromIMessageTarget(
        { kind: "handle", to: "+1 (206) 555-0100", service: "auto" },
        "sms",
      ),
    ).toEqual({ chatIdentifier: "SMS;-;+12065550100" });
    expect(
      chatContextFromIMessageTarget(
        { kind: "handle", to: "+1 (206) 555-0100", service: "imessage" },
        "sms",
      ),
    ).toEqual({ chatIdentifier: "iMessage;-;+12065550100" });
    expect(
      chatContextFromIMessageTarget({ kind: "handle", to: "User@Example.com", service: "sms" }),
    ).toEqual({ chatIdentifier: "SMS;-;user@example.com" });
  });

  it("requires a current positive account and chat cache match", () => {
    rememberIMessageReplyCache({
      accountId: "work",
      messageId: "bound-guid",
      chatGuid: "any;-;+15550001111",
      chatIdentifier: "+15550001111",
      chatId: 1,
      timestamp: Date.now(),
    });
    expect(
      resolveIMessageCachedResourceBinding("bound-guid", {
        accountId: "work",
        chatIdentifier: "iMessage;-;+15550001111",
      }),
    ).toBe("match");

    rememberIMessageReplyCache({
      accountId: "work",
      messageId: "mixed-case-email-guid",
      chatGuid: "any;-;User@Example.com",
      timestamp: Date.now(),
    });
    expect(
      resolveIMessageCachedResourceBinding("mixed-case-email-guid", {
        accountId: "work",
        chatIdentifier: "iMessage;-;user@example.com",
      }),
    ).toBe("match");
    expect(
      resolveIMessageCachedResourceBinding("bound-guid", {
        accountId: "personal",
        chatIdentifier: "iMessage;-;+15550001111",
      }),
    ).toBe("mismatch");

    rememberIMessageReplyCache({
      accountId: "work",
      messageId: "guid-only",
      chatGuid: "any;-;+15550001111",
      timestamp: Date.now(),
    });
    expect(
      resolveIMessageCachedResourceBinding("guid-only", {
        accountId: "work",
        chatId: 1,
      }),
    ).toBe("unknown");
    expect(
      resolveIMessageCachedResourceBinding("bound-guid", {
        accountId: "work",
        chatId: 99,
      }),
    ).toBe("mismatch");
    expect(
      resolveIMessageCachedResourceBinding("bound-guid", {
        accountId: "work",
        chatGuid: "iMessage;+;other",
        chatIdentifier: "iMessage;-;+15550001111",
      }),
    ).toBe("mismatch");

    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "stale-guid",
      chatId: 42,
      timestamp: Date.now() - 7 * 60 * 60 * 1000,
    });
    expect(
      resolveIMessageCachedResourceBinding("stale-guid", {
        accountId: "default",
        chatId: 42,
      }),
    ).toBe("unknown");
  });

  it("matches part-prefixed message ids only in their database chat", () => {
    expect(
      checkIMessageResourceBinding({
        chatContext: { chatId: 1 },
        cliPath,
        dbPath,
        messageId: "p:0/message-guid",
      }),
    ).toBe("match");
    expect(
      checkIMessageResourceBinding({
        chatContext: { chatGuid: "imessage;-;+15550001111" },
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("match");
    expect(
      checkIMessageResourceBinding({
        chatContext: { chatGuid: "sms;-;+15550002222" },
        cliPath,
        dbPath,
        messageId: "sms-message-guid",
      }),
    ).toBe("match");
    expect(
      checkIMessageResourceBinding({
        chatContext: { chatIdentifier: "iMessage;-;üser@example.com" },
        cliPath,
        dbPath,
        messageId: "email-message-guid",
      }),
    ).toBe("match");
    expect(
      checkIMessageResourceBinding({
        chatContext: { chatGuid: "iMessage;-;üser@example.com" },
        cliPath,
        dbPath,
        messageId: "email-message-guid",
      }),
    ).toBe("match");
    expect(
      checkIMessageResourceBinding({
        chatContext: { chatIdentifier: "iMessage;-;other@example.com" },
        cliPath,
        dbPath,
        messageId: "email-message-guid",
      }),
    ).toBe("mismatch");
    expect(
      checkIMessageResourceBinding({
        chatContext: { chatId: 2 },
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("mismatch");
    expect(
      checkIMessageResourceBinding({
        chatContext: { chatGuid: "iMessage;+;+15550001111" },
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("mismatch");
    expect(
      checkIMessageResourceBinding({
        chatContext: { chatGuid: "iMessage;+;Some@example.com" },
        cliPath,
        dbPath,
        messageId: "other-message-guid",
      }),
    ).toBe("match");
    expect(
      checkIMessageResourceBinding({
        chatContext: { chatGuid: "iMessage;+;some@example.com" },
        cliPath,
        dbPath,
        messageId: "other-message-guid",
      }),
    ).toBe("mismatch");
    expect(
      checkIMessageResourceBinding({
        chatContext: { chatIdentifier: "SMS;-;+15550001111" },
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("mismatch");
    expect(
      checkIMessageResourceBinding({
        chatContext: {
          chatId: 1,
          chatGuid: "any;-;+15550001111",
          chatIdentifier: "iMessage;-;+15550001111",
        },
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("match");
    expect(
      checkIMessageResourceBinding({
        chatContext: {
          chatGuid: "iMessage;+;other",
          chatIdentifier: "iMessage;-;+15550001111",
        },
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("mismatch");
    expect(
      checkIMessageResourceBinding({
        chatContext: { chatId: 1, chatGuid: "iMessage;+;other" },
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("mismatch");
    expect(
      checkIMessageResourceBinding({
        chatContext: { chatIdentifier: "unknown;-;+15550001111" },
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("mismatch");
  });

  it("accepts an uncached delegated reference only after a local database match", () => {
    expect(() =>
      authorizeIMessageResourceReference({
        accountId: "default",
        chatContext: { chatIdentifier: "iMessage;-;+15550001111" },
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: true,
        messageId: "message-guid",
        conversationReadOrigin: "delegated",
      }),
    ).not.toThrow();
    expect(() =>
      authorizeIMessageResourceReference({
        accountId: "default",
        chatContext: { chatGuid: "iMessage;+;other" },
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: true,
        messageId: "message-guid",
        conversationReadOrigin: "delegated",
      }),
    ).toThrow("does not belong to the selected conversation");
    expect(() =>
      authorizeIMessageResourceReference({
        accountId: "default",
        chatContext: { chatGuid: "iMessage;+;other" },
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: true,
        messageId: "message-guid",
        conversationReadOrigin: "direct-operator",
      }),
    ).toThrow("does not belong to the selected conversation");
  });

  it("uses the local database when cached chat keys are not comparable", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "message-guid",
      chatGuid: "any;-;+15550001111",
      timestamp: Date.now(),
    });

    expect(() =>
      authorizeIMessageResourceReference({
        accountId: "default",
        chatContext: { chatId: 1 },
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: true,
        messageId: "message-guid",
        conversationReadOrigin: "delegated",
      }),
    ).not.toThrow();
  });

  it("uses positive cache attestation for remote delegated calls", () => {
    rememberIMessageReplyCache({
      accountId: "work",
      messageId: "remote-guid",
      chatGuid: "any;-;+15550001111",
      timestamp: Date.now(),
    });

    expect(() =>
      authorizeIMessageResourceReference({
        accountId: "work",
        chatContext: { chatIdentifier: "iMessage;-;+15550001111" },
        cliPath: "/tmp/remote-imsg-wrapper",
        hasExclusiveLocalDatabase: false,
        remoteHost: "qa@example.invalid",
        messageId: "remote-guid",
        conversationReadOrigin: "delegated",
      }),
    ).not.toThrow();
    expect(() =>
      authorizeIMessageResourceReference({
        accountId: "work",
        chatContext: { chatIdentifier: "iMessage;-;+15550001111" },
        cliPath: "/tmp/remote-imsg-wrapper",
        hasExclusiveLocalDatabase: false,
        remoteHost: "qa@example.invalid",
        messageId: "p:0/remote-guid",
        conversationReadOrigin: "delegated",
      }),
    ).not.toThrow();
    expect(() =>
      authorizeIMessageResourceReference({
        accountId: "personal",
        chatContext: { chatIdentifier: "iMessage;-;+15550001111" },
        cliPath: "/tmp/remote-imsg-wrapper",
        hasExclusiveLocalDatabase: false,
        remoteHost: "qa@example.invalid",
        messageId: "remote-guid",
        conversationReadOrigin: "delegated",
      }),
    ).toThrow("different account or conversation");
  });

  it.each([undefined, "delegated", "unknown-origin"])(
    "fails unknown remote references closed for origin %s",
    (conversationReadOrigin) => {
      expect(() =>
        authorizeIMessageResourceReference({
          accountId: "default",
          chatContext: { chatId: 1 },
          cliPath: "/tmp/remote-imsg-wrapper",
          hasExclusiveLocalDatabase: false,
          remoteHost: "qa@example.invalid",
          messageId: "unknown-guid",
          conversationReadOrigin,
        }),
      ).toThrow("require a current same-account conversation binding");
    },
  );

  it("preserves direct operators when remote binding evidence is unavailable", () => {
    const params = {
      accountId: "default",
      chatContext: { chatId: 1 },
      cliPath: "/tmp/remote-imsg-wrapper",
      hasExclusiveLocalDatabase: false,
      remoteHost: "qa@example.invalid",
      messageId: "unknown-guid",
    };

    expect(() =>
      authorizeIMessageResourceReference({
        ...params,
        conversationReadOrigin: "direct-operator",
      }),
    ).not.toThrow();
  });

  it("does not use an account-ambiguous local database for delegated authorization", () => {
    expect(() =>
      authorizeIMessageResourceReference({
        accountId: "work",
        chatContext: { chatIdentifier: "iMessage;-;+15550001111" },
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: false,
        messageId: "message-guid",
        conversationReadOrigin: "delegated",
      }),
    ).toThrow("require a current same-account conversation binding");

    expect(() =>
      authorizeIMessageResourceReference({
        accountId: "work",
        chatContext: { chatIdentifier: "iMessage;-;+15550001111" },
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: false,
        messageId: "message-guid",
        conversationReadOrigin: "direct-operator",
      }),
    ).not.toThrow();
  });

  it("treats provider-resolved handle aliases as unavailable binding evidence", () => {
    expect(
      checkIMessageResourceBinding({
        chatContext: {},
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("unavailable");
    expect(() =>
      authorizeIMessageResourceReference({
        accountId: "default",
        chatContext: {},
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: true,
        messageId: "message-guid",
        conversationReadOrigin: "direct-operator",
      }),
    ).not.toThrow();
    expect(() =>
      authorizeIMessageResourceReference({
        accountId: "default",
        chatContext: {},
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: true,
        messageId: "message-guid",
        conversationReadOrigin: "delegated",
      }),
    ).toThrow("require a current same-account conversation binding");
  });

  it("does not treat a configured database as local for an SSH imsg wrapper", () => {
    const wrapperDir = path.join(tempDir, "wrapper");
    const wrapperPath = path.join(wrapperDir, "imsg");
    fs.mkdirSync(wrapperDir);
    fs.writeFileSync(wrapperPath, '#!/bin/sh\nexec ssh qa.example.invalid imsg "$@"\n');

    expect(
      checkIMessageResourceBinding({
        chatContext: { chatId: 1 },
        cliPath: wrapperPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("unavailable");
  });

  it("does not trust a PATH wrapper whose remote command is hidden behind variables", () => {
    const wrapperDir = path.join(tempDir, "path-wrapper");
    const wrapperPath = path.join(wrapperDir, "imsg");
    fs.mkdirSync(wrapperDir);
    fs.writeFileSync(
      wrapperPath,
      '#!/bin/sh\nhost=qa.example.invalid\nexec ssh "$host" imsg "$@"\n',
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", wrapperDir);

    expect(
      checkIMessageResourceBinding({
        chatContext: { chatId: 1 },
        cliPath: "imsg",
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("unavailable");
  });
});
