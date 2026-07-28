/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import type { AfterCommitEffect, RenderLifecycle } from "./render-lifecycle.ts";

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
      capturePullRequestEpoch: vi.fn(() => Symbol("pull-requests")),
      listBranches,
      setPullRequestSummary: vi.fn(),
    } as unknown as SessionCapability;
    const client = {
      request,
      requestSessionPullRequests: (params: { sessionKey: string }) =>
        request("controlUi.sessionPullRequests", params),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    pane.context.gateway.snapshot.hello = {
      features: {
        methods: ["controlUi.sessionPullRequests", "session.discussion.info"],
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

    expect(listBranches).toHaveBeenCalledOnce();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "session.discussion.info",
      "sessions.companion.state",
      "controlUi.sessionPullRequests",
    ]);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("drops a previous session's deferred hydration before it reaches commit", async () => {
    const request = vi.fn((_method: string, _params?: unknown) => new Promise<never>(() => {}));
    const { pane, state } = createTestChatPane({
      client: {
        request,
        requestSessionPullRequests: (params: { sessionKey: string }) =>
          request("controlUi.sessionPullRequests", params),
      } as unknown as GatewayBrowserClient,
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
