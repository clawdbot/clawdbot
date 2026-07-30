// Regression coverage for #115742: Google Chat rejects a message create call outright
// (400 INVALID_ARGUMENT) when `thread.name` is not a same-space `spaces/{space}/threads/{thread}`
// resource name. Reply routing can hand back a bare id, a message name, or a
// foreign-space thread, so `sendGoogleChatMessage` must drop those rather than fail the
// send. Resource-name format verified against Google's own Chat API reference
// (Thread resource: "Example: spaces/{space}/threads/{thread}"; threads are
// space-scoped, so a cross-space name is never valid).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { isUsableGoogleChatThreadName, sendGoogleChatMessage } from "./api.js";

describe("isUsableGoogleChatThreadName", () => {
  it("accepts a same-space thread resource name", () => {
    expect(isUsableGoogleChatThreadName("spaces/AAAA/threads/BBBB", "spaces/AAAA")).toBe(true);
  });

  it("rejects a foreign-space thread resource name", () => {
    expect(isUsableGoogleChatThreadName("spaces/OTHER/threads/BBBB", "spaces/AAAA")).toBe(false);
  });

  it("rejects a bare thread id", () => {
    expect(isUsableGoogleChatThreadName("BBBB", "spaces/AAAA")).toBe(false);
  });

  it("rejects a message resource name", () => {
    expect(isUsableGoogleChatThreadName("spaces/AAAA/messages/CCCC", "spaces/AAAA")).toBe(false);
  });

  it("rejects a thread name with extra path segments", () => {
    expect(
      isUsableGoogleChatThreadName("spaces/AAAA/threads/BBBB/messages/CCCC", "spaces/AAAA"),
    ).toBe(false);
  });
});

vi.mock("./auth.js", () => ({
  getGoogleChatAccessToken: vi.fn(async () => "test-token"),
}));

const guardedFetchMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, fetchWithSsrFGuard: guardedFetchMock };
});

const account: ResolvedGoogleChatAccount = {
  accountId: "acct-1",
  enabled: true,
  config: {},
  credentialSource: "service-account",
} as unknown as ResolvedGoogleChatAccount;

function mockGuardedResponse(body: unknown) {
  guardedFetchMock.mockImplementation(async () => ({
    response: new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    release: () => {},
  }));
}

describe("sendGoogleChatMessage thread routing", () => {
  afterEach(() => {
    guardedFetchMock.mockReset();
  });

  it("sends a valid same-space thread as a threaded reply", async () => {
    mockGuardedResponse({
      name: "spaces/AAAA/messages/new",
      thread: { name: "spaces/AAAA/threads/BBBB" },
    });

    await sendGoogleChatMessage({
      account,
      space: "spaces/AAAA",
      text: "hello",
      thread: "spaces/AAAA/threads/BBBB",
    });

    const call = guardedFetchMock.mock.calls[0]?.[0] as { url: string; init?: RequestInit };
    expect(call.url).toContain("messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    const sentBody = JSON.parse(String(call.init?.body));
    expect(sentBody.thread).toEqual({ name: "spaces/AAAA/threads/BBBB" });
  });

  it("drops an invalid thread hint and falls back to a new-thread send instead of failing", async () => {
    mockGuardedResponse({ name: "spaces/AAAA/messages/new" });

    const result = await sendGoogleChatMessage({
      account,
      space: "spaces/AAAA",
      text: "hello",
      thread: "spaces/OTHER/threads/BBBB",
    });

    expect(result).not.toBeNull();
    const call = guardedFetchMock.mock.calls[0]?.[0] as { url: string; init?: RequestInit };
    expect(call.url).not.toContain("messageReplyOption");
    const sentBody = JSON.parse(String(call.init?.body));
    expect(sentBody.thread).toBeUndefined();
  });
});
