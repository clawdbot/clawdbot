import { describe, expect, it } from "vitest";
import { extractThreadIdFromSessionKey } from "./session-key-utils.js";

describe("extractThreadIdFromSessionKey", () => {
  it("extracts topic ID from Telegram session key", () => {
    expect(extractThreadIdFromSessionKey("agent:main:telegram:group:123:topic:7")).toBe("7");
  });

  it("extracts thread ID from session key", () => {
    expect(extractThreadIdFromSessionKey("agent:main:discord:channel:123:thread:456")).toBe("456");
  });

  it("returns null for non-topic session keys", () => {
    expect(extractThreadIdFromSessionKey("agent:main:telegram:group:123")).toBeNull();
  });

  it("handles empty input", () => {
    expect(extractThreadIdFromSessionKey(null)).toBeNull();
    expect(extractThreadIdFromSessionKey(undefined)).toBeNull();
    expect(extractThreadIdFromSessionKey("")).toBeNull();
  });

  it("handles session key without agent prefix", () => {
    expect(extractThreadIdFromSessionKey("telegram:group:123:topic:7")).toBe("7");
  });

  it("extracts last thread/topic marker if multiple present", () => {
    expect(extractThreadIdFromSessionKey("agent:main:telegram:topic:1:thread:99")).toBe("99");
  });

  it("handles whitespace around thread ID", () => {
    expect(extractThreadIdFromSessionKey("agent:main:telegram:group:123:topic: 42 ")).toBe("42");
  });

  it("returns null when thread marker is at the end without ID", () => {
    expect(extractThreadIdFromSessionKey("agent:main:telegram:group:123:topic:")).toBeNull();
  });
});
