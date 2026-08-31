// Session-state notice context key decoding: strict UTF-8 after hex validation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import {
  decodeSessionStateNoticeContextKey,
  enqueueSessionStateNotice,
} from "./session-state-notices.js";

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeat: vi.fn(),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(requestHeartbeat).mockClear();
});

function encodeTarget(sessionKey: string): string {
  return `session-state:${Buffer.from(sessionKey, "utf8").toString("hex")}`;
}

describe("decodeSessionStateNoticeContextKey", () => {
  it("round-trips a valid encoded session key", () => {
    const sessionKey = "agent:main:slack:channel:C01234567";
    expect(decodeSessionStateNoticeContextKey(encodeTarget(sessionKey))).toBe(sessionKey);
  });

  it("round-trips a session key with a leading U+FEFF unchanged", () => {
    const sessionKey = "﻿agent:main";
    expect(decodeSessionStateNoticeContextKey(encodeTarget(sessionKey))).toBe(sessionKey);
  });

  it("rejects a context key whose hex payload is not valid UTF-8", () => {
    // 0xFF is not valid UTF-8; a forgiving decode would return U+FFFD and let a
    // corrupt context key collide with an unrelated watcher cursor.
    expect(decodeSessionStateNoticeContextKey("session-state:ff")).toBeUndefined();
  });

  it("rejects malformed prefixes and hex payloads", () => {
    expect(decodeSessionStateNoticeContextKey("other:ff")).toBeUndefined();
    expect(decodeSessionStateNoticeContextKey("session-state:")).toBeUndefined();
    expect(decodeSessionStateNoticeContextKey("session-state:abc")).toBeUndefined();
    expect(decodeSessionStateNoticeContextKey("session-state:zz")).toBeUndefined();
  });
});

describe("enqueueSessionStateNotice", () => {
  it("coalesces active wakes for 20 seconds and leaves queue-only notices asleep", () => {
    const notice = {
      watcherSessionKey: "agent:main:main",
      targetSessionKey: "agent:main:slack:channel:C01234567",
      lastSeenSequence: 42,
    };

    enqueueSessionStateNotice(notice);
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "session-state",
      intent: "immediate",
      reason: `session-state:${notice.targetSessionKey}`,
      sessionKey: notice.watcherSessionKey,
      coalesceMs: 20_000,
    });

    vi.mocked(requestHeartbeat).mockClear();
    enqueueSessionStateNotice({ ...notice, queueOnly: true });
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });
});
