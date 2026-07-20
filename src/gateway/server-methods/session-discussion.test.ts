import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDiscussionProvider } from "../../plugins/session-discussion-registry.js";
import { sessionDiscussionHandlers } from "./session-discussion.js";

const mocks = vi.hoisted(() => ({ getProvider: vi.fn() }));

vi.mock("../../plugins/session-discussion-registry.js", () => ({
  getSessionDiscussionProvider: mocks.getProvider,
}));

type Method = "session.discussion.info" | "session.discussion.open";

async function invoke(method: Method, params: Record<string, unknown>) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  await sessionDiscussionHandlers[method]?.({
    req: { type: "req", id: method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => calls.push({ ok, payload, error }),
    context: {} as never,
  });
  return calls[0];
}

function provider() {
  const info = vi.fn<SessionDiscussionProvider["info"]>().mockResolvedValue({
    state: "open",
    embedUrl: "https://chat.example/embed/thread",
    openUrl: "https://chat.example/thread",
  });
  const open = vi.fn<SessionDiscussionProvider["open"]>().mockResolvedValue({ state: "available" });
  return {
    value: { id: "test", info, open } satisfies SessionDiscussionProvider,
    info,
    open,
  };
}

describe("session discussion gateway methods", () => {
  beforeEach(() => {
    mocks.getProvider.mockReset();
  });

  it.each(["session.discussion.info", "session.discussion.open"] as const)(
    "returns none when %s has no provider",
    async (method) => {
      mocks.getProvider.mockReturnValue(undefined);
      expect(await invoke(method, { sessionKey: "agent:main:thread" })).toMatchObject({
        ok: true,
        payload: { state: "none" },
      });
    },
  );

  it("passes the session key to info and returns its result", async () => {
    const registered = provider();
    mocks.getProvider.mockReturnValue(registered.value);

    const response = await invoke("session.discussion.info", {
      sessionKey: "agent:main:thread",
    });

    expect(registered.info).toHaveBeenCalledWith({ sessionKey: "agent:main:thread" });
    expect(response).toMatchObject({
      ok: true,
      payload: {
        state: "open",
        embedUrl: "https://chat.example/embed/thread",
        openUrl: "https://chat.example/thread",
      },
    });
  });

  it("passes the session key to open and returns its result", async () => {
    const registered = provider();
    mocks.getProvider.mockReturnValue(registered.value);

    const response = await invoke("session.discussion.open", {
      sessionKey: "agent:main:thread",
    });

    expect(registered.open).toHaveBeenCalledWith({ sessionKey: "agent:main:thread" });
    expect(response).toMatchObject({ ok: true, payload: { state: "available" } });
  });

  it.each(["session.discussion.info", "session.discussion.open"] as const)(
    "returns a retryable error when the provider throws from %s",
    async (method) => {
      const registered = provider();
      const operation = method === "session.discussion.info" ? registered.info : registered.open;
      operation.mockRejectedValueOnce(new Error("provider failed"));
      mocks.getProvider.mockReturnValue(registered.value);

      expect(await invoke(method, { sessionKey: "agent:main:thread" })).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
    },
  );

  it.each(["session.discussion.info", "session.discussion.open"] as const)(
    "rejects a malformed provider result from %s",
    async (method) => {
      const registered = provider();
      const operation = method === "session.discussion.info" ? registered.info : registered.open;
      operation.mockResolvedValueOnce({ state: "invalid" } as never);
      mocks.getProvider.mockReturnValue(registered.value);

      expect(await invoke(method, { sessionKey: "agent:main:thread" })).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
    },
  );

  it.each(["session.discussion.info", "session.discussion.open"] as const)(
    "rejects an empty session key for %s",
    async (method) => {
      expect(await invoke(method, { sessionKey: "" })).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    },
  );
});
