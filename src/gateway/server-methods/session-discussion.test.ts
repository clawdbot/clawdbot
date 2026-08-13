import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionDiscussionProvider } from "../../plugins/session-discussion-registry.js";
import { sessionDiscussionHandlers } from "./session-discussion.js";

const mocks = vi.hoisted(() => ({
  emitSessionsChanged: vi.fn(),
  generateConversationLabelWithFallback: vi.fn(),
  getProvider: vi.fn(),
  loadSessionTarget: vi.fn(),
  maybeGenerateSessionTitle: vi.fn(),
  readSessionTitleFields: vi.fn(),
  resolveUtilityModelRefForAgent: vi.fn(),
  updateSessionEntry: vi.fn(),
}));

vi.mock("../../plugins/session-discussion-registry.js", () => ({
  getSessionDiscussionProvider: mocks.getProvider,
}));
vi.mock("../../agents/utility-model.js", () => ({
  resolveUtilityModelRefForAgent: mocks.resolveUtilityModelRefForAgent,
}));
vi.mock("../../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback: mocks.generateConversationLabelWithFallback,
}));
vi.mock("../../config/sessions/session-accessor.js", () => ({
  updateSessionEntry: mocks.updateSessionEntry,
}));
vi.mock("../dashboard-session-title.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dashboard-session-title.js")>();
  mocks.maybeGenerateSessionTitle.mockImplementation(actual.maybeGenerateSessionTitle);
  return { ...actual, maybeGenerateSessionTitle: mocks.maybeGenerateSessionTitle };
});
vi.mock("../session-transcript-title-reader.js", () => ({
  readSessionTitleFieldsFromTranscript: mocks.readSessionTitleFields,
}));
vi.mock("./session-change-event.js", () => ({
  emitSessionsChanged: mocks.emitSessionsChanged,
}));
vi.mock("./sessions-shared.js", () => ({
  loadAccessorSessionEntryForGatewayTarget: mocks.loadSessionTarget,
}));

const cfg = {
  agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
} as OpenClawConfig;
const sessionKey = "agent:main:thread";
const storePath = "/tmp/openclaw/sessions.sqlite";

type Method = "session.discussion.info" | "session.discussion.open";

async function invoke(
  method: Method,
  params: Record<string, unknown>,
  runtimeConfig: OpenClawConfig = cfg,
) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  await sessionDiscussionHandlers[method]?.({
    req: { type: "req", id: method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => calls.push({ ok, payload, error }),
    context: { getRuntimeConfig: () => runtimeConfig } as never,
  });
  return calls[0];
}

function mockSession(entry: SessionEntry | undefined): void {
  mocks.loadSessionTarget.mockReturnValue({
    canonicalKey: sessionKey,
    entry,
    storePath,
    target: { agentId: "main" },
  });
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
    mocks.emitSessionsChanged.mockReset();
    mocks.generateConversationLabelWithFallback.mockReset();
    mocks.getProvider.mockReset();
    mocks.loadSessionTarget.mockReset();
    mocks.maybeGenerateSessionTitle.mockClear();
    mocks.readSessionTitleFields.mockReset();
    mocks.resolveUtilityModelRefForAgent.mockReset();
    mocks.updateSessionEntry.mockReset();
    mocks.generateConversationLabelWithFallback.mockResolvedValue("Release Planning");
    mocks.readSessionTitleFields.mockReturnValue({
      firstUserMessage: null,
      lastMessagePreview: null,
    });
    mocks.resolveUtilityModelRefForAgent.mockReturnValue("openai/gpt-5.6-luna");
    mockSession(undefined);
  });

  afterEach(() => vi.useRealTimers());

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

    expect(registered.info).toHaveBeenCalledWith({
      sessionKey: "agent:main:thread",
      agentId: "main",
    });
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

    expect(registered.open).toHaveBeenCalledWith({
      sessionKey: "agent:main:thread",
      agentId: "main",
    });
    expect(response).toMatchObject({ ok: true, payload: { state: "available" } });
  });

  it("admits bare fixed-store keys only through their persisted owner", async () => {
    const registered = provider();
    mocks.getProvider.mockReturnValue(registered.value);
    mockSession({ sessionId: "session-ops-global", updatedAt: 1 });
    const ownedConfig: OpenClawConfig = {
      session: { scope: "global", store: "/tmp/shared-sessions.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    expect(
      await invoke("session.discussion.open", { sessionKey: "global" }, ownedConfig),
    ).toMatchObject({ ok: true, payload: { state: "available" } });
    expect(mocks.loadSessionTarget).toHaveBeenCalledWith({
      cfg: ownedConfig,
      key: "global",
      agentId: "ops",
    });

    const ownerlessConfig: OpenClawConfig = {
      ...ownedConfig,
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };
    expect(
      await invoke("session.discussion.info", { sessionKey: "global" }, ownerlessConfig),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("has no explicit owner") },
    });
    expect(registered.info).not.toHaveBeenCalled();
  });

  it("persists a generated title before opening an untitled session discussion", async () => {
    const entry: SessionEntry = { sessionId: "session-1", updatedAt: 1 };
    let persistedEntry: SessionEntry | undefined;
    mockSession(entry);
    mocks.readSessionTitleFields.mockReturnValue({
      firstUserMessage: "[Mon 2026-07-27 09:00 PDT] Plan the release",
      lastMessagePreview: null,
    });
    mocks.updateSessionEntry.mockImplementation(async (_scope, update) => {
      const patch = await update({ ...entry });
      persistedEntry = patch ? { ...entry, ...patch } : undefined;
      return persistedEntry;
    });
    const registered = provider();
    mocks.getProvider.mockReturnValue(registered.value);

    await invoke("session.discussion.open", { sessionKey });

    expect(mocks.maybeGenerateSessionTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        entry,
        sessionId: "session-1",
        sessionKey,
        storePath,
        userMessage: "",
      }),
    );
    expect(persistedEntry?.displayName).toBe("Release Planning");
    expect(
      mocks.updateSessionEntry.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    ).toBeLessThan(registered.open.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY);
    expect(mocks.emitSessionsChanged).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ sessionKey, agentId: "main", reason: "chat.title" }),
    );
  });

  it("attempts a title when system prompt state already exists", async () => {
    const entry: SessionEntry = { sessionId: "session-1", updatedAt: 1, systemSent: true };
    mockSession(entry);
    mocks.readSessionTitleFields.mockReturnValue({
      firstUserMessage: "Plan the release",
      lastMessagePreview: null,
    });
    mocks.updateSessionEntry.mockImplementation(async (_scope, update) => {
      const patch = await update({ ...entry });
      return patch ? { ...entry, ...patch } : entry;
    });
    const registered = provider();
    mocks.getProvider.mockReturnValue(registered.value);

    await invoke("session.discussion.open", { sessionKey });

    expect(mocks.maybeGenerateSessionTitle).toHaveBeenCalledOnce();
    expect(mocks.generateConversationLabelWithFallback).toHaveBeenCalledOnce();
  });

  it("titles via the canonical session key when opened through an alias key", async () => {
    const entry: SessionEntry = { sessionId: "session-1", updatedAt: 1 };
    mocks.loadSessionTarget.mockReturnValue({
      canonicalKey: sessionKey,
      entry,
      storePath,
      target: { agentId: "main" },
    });
    mocks.readSessionTitleFields.mockReturnValue({
      firstUserMessage: "Plan the release",
      lastMessagePreview: null,
    });
    mocks.updateSessionEntry.mockImplementation(async (_scope, update) => {
      const patch = await update({ ...entry });
      return patch ? { ...entry, ...patch } : undefined;
    });
    const registered = provider();
    mocks.getProvider.mockReturnValue(registered.value);

    await invoke("session.discussion.open", { sessionKey: "agent:main:thread-alias" });

    expect(mocks.maybeGenerateSessionTitle).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey }),
    );
  });

  it("does not generate a title for an explicitly named session", async () => {
    mockSession({ sessionId: "session-1", updatedAt: 1, displayName: "Manual title" });
    const registered = provider();
    mocks.getProvider.mockReturnValue(registered.value);

    await invoke("session.discussion.open", { sessionKey });

    expect(mocks.maybeGenerateSessionTitle).not.toHaveBeenCalled();
    expect(mocks.readSessionTitleFields).not.toHaveBeenCalled();
    expect(registered.open).toHaveBeenCalledOnce();
  });

  it("opens the discussion when title generation times out", async () => {
    vi.useFakeTimers();
    mockSession({ sessionId: "session-timeout", updatedAt: 1 });
    mocks.readSessionTitleFields.mockReturnValue({
      firstUserMessage: "Plan the release",
      lastMessagePreview: null,
    });
    // Resolvable deferred: settling it after the assertions evicts the shared
    // single-flight map entry so module state stays clean across suites.
    let releaseGeneration: ((value: string | null) => void) | undefined;
    mocks.generateConversationLabelWithFallback.mockReturnValue(
      new Promise<string | null>((resolve) => {
        releaseGeneration = resolve;
      }),
    );
    const registered = provider();
    mocks.getProvider.mockReturnValue(registered.value);

    const responsePromise = invoke("session.discussion.open", { sessionKey });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(responsePromise).resolves.toMatchObject({
      ok: true,
      payload: { state: "available" },
    });
    expect(registered.open).toHaveBeenCalledOnce();
    expect(mocks.emitSessionsChanged).not.toHaveBeenCalled();
    releaseGeneration?.(null);
    // Bounded flush: eviction settles via microtasks, so advancing 0ms is
    // enough. runAllTimersAsync livelocks (10000-timer abort) when any other
    // suite in a shared shard worker schedules an interval into this fake clock.
    await vi.advanceTimersByTimeAsync(0);
  });

  it("never generates a title for discussion info", async () => {
    mockSession({ sessionId: "session-1", updatedAt: 1 });
    const registered = provider();
    mocks.getProvider.mockReturnValue(registered.value);

    await invoke("session.discussion.info", { sessionKey });

    expect(mocks.loadSessionTarget).not.toHaveBeenCalled();
    expect(mocks.maybeGenerateSessionTitle).not.toHaveBeenCalled();
    expect(registered.info).toHaveBeenCalledOnce();
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
