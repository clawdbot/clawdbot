import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSentMessageCache } from "./echo-cache.js";
import { rememberPersistedIMessageEcho } from "./persisted-echo-cache.js";

describe("iMessage sent-message echo cache", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches recent text within the same scope", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "  Reasoning:\r\n_step_  " });

    expect(cache.has("acct:imessage:+1555", { text: "Reasoning:\n_step_" })).toBe(true);
    expect(cache.has("acct:imessage:+1666", { text: "Reasoning:\n_step_" })).toBe(false);
  });

  it("matches delayed reflected echoes with leading attributedBody corruption markers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "Delayed echo reply" });

    expect(
      cache.has("acct:imessage:+1555", {
        text: "\uFFFD\uFFFE\uFFFF\uFEFFDelayed echo reply",
      }),
    ).toBe(true);
  });

  it("keeps attributedBody corruption cleanup leading-only", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "Delayed echo reply" });

    expect(
      cache.has("acct:imessage:+1555", {
        text: "Delayed \uFFFD echo reply",
      }),
    ).toBe(false);
    expect(cache.has("acct:imessage:+1555", { text: "Delayed\techo reply" })).toBe(false);
    expect(cache.has("acct:imessage:+1555", { text: "Delayed\necho reply" })).toBe(false);
  });

  it("matches by outbound message id and ignores placeholder ids", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { messageId: "abc-123" });
    cache.remember("acct:imessage:+1555", { messageId: "ok" });

    expect(cache.has("acct:imessage:+1555", { messageId: "abc-123" })).toBe(true);
    expect(cache.has("acct:imessage:+1555", { messageId: "ok" })).toBe(false);
  });

  it("keeps message-id lookups longer than text fallback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "hello", messageId: "m-1" });
    // Text fallback stays short to avoid suppressing legitimate repeated user text.
    vi.advanceTimersByTime(6_000);

    expect(cache.has("acct:imessage:+1555", { text: "hello" })).toBe(false);
    expect(cache.has("acct:imessage:+1555", { messageId: "m-1" })).toBe(true);
  });

  it("matches persisted echoes written by another process", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-echo-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const cache = createSentMessageCache();

    rememberPersistedIMessageEcho({
      scope: "acct:imessage:+1555",
      text: "OpenClaw imsg live test",
      messageId: "guid-1",
    });

    expect(cache.has("acct:imessage:+1555", { text: "OpenClaw imsg live test" })).toBe(true);
    expect(cache.has("acct:imessage:+1666", { text: "OpenClaw imsg live test" })).toBe(false);
    expect(cache.has("acct:imessage:+1555", { messageId: "guid-1" })).toBe(true);
  });

  it("writes sent-echoes.jsonl 0600 and parent dir 0700", () => {
    // sent-echoes.jsonl carries scope keys + outbound message text + messageIds.
    // Same threat model as reply-cache.jsonl: a same-UID hostile process could
    // enumerate active conversations or inject lines so a future inbound dedupe
    // call wrongly suppresses a legitimate inbound. Owner-only mode is the
    // mitigation.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-echo-perm-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    rememberPersistedIMessageEcho({
      scope: "acct:imessage:+1555",
      text: "perm-test",
      messageId: "guid-perm",
    });

    const echoFile = path.join(stateDir, "imessage", "sent-echoes.jsonl");
    const echoDir = path.dirname(echoFile);
    expect(fs.existsSync(echoFile)).toBe(true);

    const fileMode = fs.statSync(echoFile).mode & 0o777;
    const dirMode = fs.statSync(echoDir).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it("retains entries written hours earlier so catchup replay sees own outbound rows", () => {
    // Catchup's default maxAgeMinutes is 120 (2h). The persisted-echo TTL must
    // be >= that window, otherwise the agent's own outbound rows from before
    // a gateway gap fall out of dedupe before catchup re-feeds the inbound
    // rows around them — and the agent's replies to itself land back in the
    // inbound pipeline as if they were external sends. Regression guard for
    // the echo-cache retention extension that ships with #78649.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-echo-ttl-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    rememberPersistedIMessageEcho({
      scope: "acct:imessage:+1555",
      text: "agent reply from before the gap",
      messageId: "guid-pre-gap",
    });

    // Advance 3 hours — past the legacy 2-min TTL but well within the 12 h
    // retention required by the maxAgeMinutes=720 clamp.
    vi.setSystemTime(new Date("2026-05-08T15:00:00Z"));
    const cache = createSentMessageCache();
    expect(cache.has("acct:imessage:+1555", { text: "agent reply from before the gap" })).toBe(
      true,
    );
    expect(cache.has("acct:imessage:+1555", { messageId: "guid-pre-gap" })).toBe(true);
  });

  it("clamps pre-existing sent-echoes.jsonl from older 0644/0755 to 0600/0700", () => {
    // Older gateway versions wrote with default modes. After upgrade, the next
    // remember must clamp the existing file/dir back to owner-only.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-echo-clamp-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const imsgDir = path.join(stateDir, "imessage");
    fs.mkdirSync(imsgDir, { recursive: true, mode: 0o755 });
    const echoFile = path.join(imsgDir, "sent-echoes.jsonl");
    fs.writeFileSync(echoFile, "", { mode: 0o644 });
    fs.chmodSync(imsgDir, 0o755);
    fs.chmodSync(echoFile, 0o644);

    rememberPersistedIMessageEcho({
      scope: "acct:imessage:+1555",
      text: "clamp-test",
      messageId: "guid-clamp",
    });

    const fileMode = fs.statSync(echoFile).mode & 0o777;
    const dirMode = fs.statSync(imsgDir).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });
});
