/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../lib/session-pull-requests.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import type { AfterCommitEffect, RenderLifecycle } from "./render-lifecycle.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createSecondaryHydrationPane() {
  const secondaryResponse = new Promise<never>(() => {});
  const request = vi.fn((_method: string, _params?: unknown) => secondaryResponse);
  const listBranches = vi.fn(() => secondaryResponse);
  const patch = vi.fn().mockResolvedValue({});
  const sessions = {
    capturePullRequestEpoch: vi.fn(() => ({})),
    listBranches,
    patch,
    setPullRequestSummary: vi.fn(),
  } as unknown as SessionCapability;
  const { pane, state } = createTestChatPane({
    client: { request } as unknown as GatewayBrowserClient,
    sessions,
  });
  state.assistantAgentId = "main";
  state.sessionKey = "agent:work:current";
  pane.context.gateway.snapshot.hello = gatewayHelloForMethods([
    SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
    "session.discussion.info",
    "sessions.patch",
  ]);
  const commitEffects: AfterCommitEffect[] = [];
  const afterCommit = vi.fn((effect: AfterCommitEffect) => {
    commitEffects.push(effect);
    return () => undefined;
  });
  state.renderLifecycle = { invalidate: vi.fn(), afterCommit } satisfies RenderLifecycle;
  return { afterCommit, commitEffects, listBranches, pane, patch, request, state };
}

describe("chat pane session hydration", () => {
  it("starts secondary RPCs together only after the transcript commit", async () => {
    const { afterCommit, commitEffects, listBranches, pane, request, state } =
      createSecondaryHydrationPane();
    const transcript = deferred<boolean>();

    pane.deferSessionHydrationUntilTranscript(state.sessionKey, transcript.promise);

    expect(request).not.toHaveBeenCalled();
    expect(listBranches).not.toHaveBeenCalled();
    transcript.resolve(true);
    await transcript.promise;
    await Promise.resolve();

    expect(afterCommit).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(listBranches).not.toHaveBeenCalled();

    const complete = vi.fn();
    commitEffects[0]!(complete);
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

  it("drops a previous session's deferred hydration before it reaches commit", async () => {
    const request = vi.fn((_method: string, _params?: unknown) => new Promise<never>(() => {}));
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const afterCommit = vi.fn<RenderLifecycle["afterCommit"]>(() => () => undefined);
    state.renderLifecycle = { invalidate: vi.fn(), afterCommit };
    const previousTranscript = deferred<boolean>();
    const currentTranscript = deferred<boolean>();

    pane.deferSessionHydrationUntilTranscript(state.sessionKey, previousTranscript.promise);
    state.sessionKey = "agent:main:current-2";
    pane.deferSessionHydrationUntilTranscript(state.sessionKey, currentTranscript.promise);

    previousTranscript.resolve(true);
    await previousTranscript.promise;
    await Promise.resolve();
    expect(afterCommit).not.toHaveBeenCalled();

    currentTranscript.resolve(true);
    await currentTranscript.promise;
    await Promise.resolve();
    expect(afterCommit).toHaveBeenCalledOnce();
  });

  it("resumes deferred companion and discussion hydration when a retained pane returns", async () => {
    const { commitEffects, pane, request, state } = createSecondaryHydrationPane();
    const transcript = deferred<boolean>();

    pane.deferSessionHydrationUntilTranscript(state.sessionKey, transcript.promise);
    pane.presented = false;
    transcript.resolve(true);
    await transcript.promise;
    await Promise.resolve();

    expect(commitEffects).toHaveLength(0);
    expect(request).not.toHaveBeenCalled();

    pane.presented = true;
    expect(commitEffects).toHaveLength(1);
    commitEffects[0]!(vi.fn());
    await Promise.resolve();

    const methods = request.mock.calls.map(([method]) => method);
    expect(methods).toContain("session.discussion.info");
    expect(methods).toContain("sessions.companion.state");
  });

  it.each([
    { name: "commits", committed: true, expectedPatches: 1 },
    { name: "fails", committed: false, expectedPatches: 0 },
  ])(
    "acknowledges unread only after deferred transcript hydration $name",
    async ({ committed, expectedPatches }) => {
      const { commitEffects, pane, patch, state } = createSecondaryHydrationPane();
      const transcript = deferred<boolean>();
      state.sessionsResult = {
        sessions: [
          {
            key: state.sessionKey,
            kind: "direct",
            updatedAt: 20,
            unread: true,
          },
        ],
      } as never;

      pane.presented = false;
      pane.deferSessionHydrationUntilTranscript(state.sessionKey, transcript.promise);
      pane.presented = true;
      expect(patch).not.toHaveBeenCalled();

      transcript.resolve(committed);
      await transcript.promise;
      await Promise.resolve();
      expect(commitEffects).toHaveLength(1);

      commitEffects[0]!(vi.fn());
      await Promise.resolve();
      expect(patch).toHaveBeenCalledTimes(expectedPatches);
    },
  );
});
