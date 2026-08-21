/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../lib/session-pull-requests.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import type { AfterCommitEffect, RenderLifecycle } from "./render-lifecycle.ts";

const GITHUB_PREVIEW_METHOD = "controlUi.githubPreview";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("chat pane session hydration", () => {
  it("starts secondary RPCs together only after the transcript commit", async () => {
    const secondaryResponse = new Promise<never>(() => {});
    const request = vi.fn((_method: string, _params?: unknown) => secondaryResponse);
    const listBranches = vi.fn(() => secondaryResponse);
    const sessions = {
      capturePullRequestEpoch: vi.fn(() => ({})),
      listBranches,
      setPullRequestSummary: vi.fn(),
    } as unknown as SessionCapability;
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    state.assistantAgentId = "main";
    state.sessionKey = "agent:work:current";
    pane.context.gateway.snapshot.hello = {
      features: {
        methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, "session.discussion.info"],
      },
    } as never;
    const commitEffects: AfterCommitEffect[] = [];
    const afterCommit = vi.fn((effect: AfterCommitEffect) => {
      commitEffects.push(effect);
      return () => undefined;
    });
    state.renderLifecycle = {
      invalidate: vi.fn(),
      afterCommit,
    } satisfies RenderLifecycle;
    const transcript = deferred<void>();

    pane.deferSessionHydrationUntilTranscript(state.sessionKey, transcript.promise);

    expect(request).not.toHaveBeenCalled();
    expect(listBranches).not.toHaveBeenCalled();
    transcript.resolve();
    await transcript.promise;
    await Promise.resolve();

    expect(afterCommit).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(listBranches).not.toHaveBeenCalled();

    const complete = vi.fn();
    commitEffects[0]?.(complete);
    await Promise.resolve();

    expect(listBranches).toHaveBeenCalledOnce();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "session.discussion.info",
      "sessions.companion.state",
      SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
    ]);
    expect(
      request.mock.calls.find(([method]) => method === "sessions.companion.state")?.[1],
    ).toEqual({ sessionKey: state.sessionKey, agentId: "work" });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("keeps hidden retained-pane hydration independent of preview prewarming", async () => {
    const request = vi.fn((_method: string, _params?: unknown) => Promise.resolve({}));
    const listBranches = vi.fn(() => Promise.resolve([]));
    const sessions = {
      capturePullRequestEpoch: vi.fn(() => Symbol("pull-requests")),
      listBranches,
      setPullRequestSummary: vi.fn(),
    } as unknown as SessionCapability;
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions,
    });
    state.assistantAgentId = "main";
    state.sessionKey = "agent:work:current";
    pane.context.gateway.snapshot.hello = {
      features: {
        methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, "session.discussion.info"],
      },
    } as never;
    const thread = document.createElement("div");
    thread.className = "chat-thread";
    const anchor = document.createElement("a");
    anchor.className = "markdown-github-link";
    anchor.href = "https://github.com/openclaw/openclaw/issues/1";
    thread.append(anchor);
    pane.append(thread);
    const commitEffects: AfterCommitEffect[] = [];
    state.renderLifecycle = {
      invalidate: vi.fn(),
      afterCommit: (effect) => {
        commitEffects.push(effect);
        return () => undefined;
      },
    };
    const transcript = deferred<void>();

    pane.deferSessionHydrationUntilTranscript(state.sessionKey, transcript.promise);
    pane.presented = false;
    transcript.resolve();
    await transcript.promise;
    await Promise.resolve();

    expect(commitEffects).toHaveLength(1);
    const complete = vi.fn();
    commitEffects[0]?.(complete);
    await Promise.resolve();

    expect(listBranches).toHaveBeenCalledOnce();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "session.discussion.info",
      "sessions.companion.state",
    ]);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("prewarms the newest three unique rendered GitHub cards after commit", async () => {
    const request = vi.fn((_method: string, params?: unknown) =>
      (params as { number?: number } | undefined)?.number === 4
        ? Promise.reject(new Error("missing preview"))
        : Promise.resolve({}),
    );
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const thread = document.createElement("div");
    thread.className = "chat-thread";
    for (const href of [
      "https://github.com/openclaw/openclaw/issues/1",
      "https://github.com/openclaw/openclaw/pull/2",
      "https://github.com/openclaw/openclaw/pull/2#discussion_r1",
      "https://example.com/openclaw/openclaw/issues/3",
      "https://github.com/openclaw/openclaw/issues/3",
      "https://github.com/openclaw/openclaw/pull/4/files",
    ]) {
      const anchor = document.createElement("a");
      anchor.className = "markdown-github-link";
      anchor.href = href;
      thread.append(anchor);
    }
    pane.append(thread);
    const commitEffects: AfterCommitEffect[] = [];
    state.renderLifecycle = {
      invalidate: vi.fn(),
      afterCommit: (effect) => {
        commitEffects.push(effect);
        return () => undefined;
      },
    };
    const transcript = deferred<void>();

    pane.deferSessionHydrationUntilTranscript(state.sessionKey, transcript.promise);
    expect(request).not.toHaveBeenCalled();
    transcript.resolve();
    await transcript.promise;
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    const complete = vi.fn();
    commitEffects[0]?.(complete);
    expect(complete).toHaveBeenCalledOnce();

    await vi.waitFor(() => {
      expect(
        request.mock.calls.filter(([method]) => method === GITHUB_PREVIEW_METHOD),
      ).toHaveLength(3);
    });
    expect(
      request.mock.calls
        .filter(([method]) => method === GITHUB_PREVIEW_METHOD)
        .map(([, params]) => params),
    ).toEqual([
      { kind: "pull", number: 4, owner: "openclaw", repo: "openclaw" },
      { kind: "issue", number: 3, owner: "openclaw", repo: "openclaw" },
      { kind: "pull", number: 2, owner: "openclaw", repo: "openclaw" },
    ]);
  });

  it("aborts an in-flight preview prewarm when the session changes", async () => {
    const preview = deferred<unknown>();
    const request = vi.fn(
      (method: string, _params?: unknown, _options?: { signal?: AbortSignal }) =>
        method === GITHUB_PREVIEW_METHOD ? preview.promise : Promise.resolve({}),
    );
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: [GITHUB_PREVIEW_METHOD] },
    } as never;
    const thread = document.createElement("div");
    thread.className = "chat-thread";
    for (const number of [5, 6]) {
      const anchor = document.createElement("a");
      anchor.className = "markdown-github-link";
      anchor.href = `https://github.com/openclaw/openclaw/issues/${number}`;
      thread.append(anchor);
    }
    pane.append(thread);
    const commitEffects: AfterCommitEffect[] = [];
    state.renderLifecycle = {
      invalidate: vi.fn(),
      afterCommit: (effect) => {
        commitEffects.push(effect);
        return () => undefined;
      },
    };
    const firstTranscript = deferred<void>();

    pane.deferSessionHydrationUntilTranscript(state.sessionKey, firstTranscript.promise);
    firstTranscript.resolve();
    await firstTranscript.promise;
    await Promise.resolve();
    commitEffects[0]?.(vi.fn());
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        GITHUB_PREVIEW_METHOD,
        expect.anything(),
        expect.anything(),
      ),
    );
    const signal = request.mock.calls.find(([method]) => method === GITHUB_PREVIEW_METHOD)?.[2]
      ?.signal;
    expect(signal).toBeDefined();

    state.sessionKey = "agent:main:next";
    pane.deferSessionHydrationUntilTranscript(state.sessionKey, Promise.resolve());

    preview.resolve({});
    await preview.promise;
    await Promise.resolve();
    expect(request.mock.calls.filter(([method]) => method === GITHUB_PREVIEW_METHOD)).toHaveLength(
      1,
    );
    expect(signal?.aborted).toBe(true);
  });

  it("drops a previous session's deferred hydration before it reaches commit", async () => {
    const request = vi.fn((_method: string, _params?: unknown) => new Promise<never>(() => {}));
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const afterCommit = vi.fn<RenderLifecycle["afterCommit"]>(() => () => undefined);
    state.renderLifecycle = { invalidate: vi.fn(), afterCommit };
    const previousTranscript = deferred<void>();
    const currentTranscript = deferred<void>();

    pane.deferSessionHydrationUntilTranscript(state.sessionKey, previousTranscript.promise);
    state.sessionKey = "agent:main:current-2";
    pane.deferSessionHydrationUntilTranscript(state.sessionKey, currentTranscript.promise);

    previousTranscript.resolve();
    await previousTranscript.promise;
    await Promise.resolve();
    expect(afterCommit).not.toHaveBeenCalled();

    currentTranscript.resolve();
    await currentTranscript.promise;
    await Promise.resolve();
    expect(afterCommit).toHaveBeenCalledOnce();
  });
});
