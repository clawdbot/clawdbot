import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createTestSessionCapability } from "./session-capability.test-support.ts";
import type { GitHubPublicationBinding, SessionGateway } from "./session-capability.ts";

function sessionsResult(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: 2,
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function createGatewayHarness(client: GatewayBrowserClient) {
  let snapshot: SessionGateway["snapshot"] = {
    client: client as GatewayBrowserClient | null,
    phase: "connected" as ApplicationGatewayPhase,
    sessionKey: "agent:main:main",
    assistantAgentId: "main",
    hello: null,
  };
  const listeners = new Set<(next: typeof snapshot) => void>();
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeEvents(listener: (event: GatewayEventFrame) => void) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
    },
    emitEvent(this: void, event: GatewayEventFrame) {
      for (const listener of eventListeners) {
        listener(event);
      }
    },
    update(this: void, next: Partial<SessionGateway["snapshot"]>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    publish(
      this: void,
      connected: boolean,
      nextClient: GatewayBrowserClient | null = snapshot.client,
    ) {
      snapshot = {
        ...snapshot,
        client: nextClient,
        phase: connected ? "connected" : "reconnecting",
      };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

describe("session pull-request state", () => {
  it("publishes state removal for client replacement and disconnect", () => {
    const harness = createGatewayHarness({} as GatewayBrowserClient);
    const sessions = createTestSessionCapability(harness.gateway);
    const listener = vi.fn();
    const summary = { numbers: [111532], state: "open" as const };
    sessions.subscribe(listener);

    sessions.setPullRequestSummary("agent:main:pr-session", summary);
    expect(sessions.pullRequestSummary("agent:main:pr-session")).toEqual(summary);
    expect(listener).toHaveBeenCalledTimes(1);

    sessions.setPullRequestSummary("agent:main:pr-session", summary);
    expect(listener).toHaveBeenCalledTimes(1);

    const publicationsBeforeReplacement = listener.mock.calls.length;
    harness.publish(true, {} as GatewayBrowserClient);
    expect(sessions.pullRequestSummary("agent:main:pr-session")).toBeUndefined();
    expect(listener.mock.calls.length).toBeGreaterThan(publicationsBeforeReplacement);

    sessions.setPullRequestSummary("agent:main:pr-session", summary);
    const publicationsBeforeDisconnect = listener.mock.calls.length;
    harness.publish(false);
    expect(sessions.pullRequestSummary("agent:main:pr-session")).toBeUndefined();
    expect(listener.mock.calls.length).toBeGreaterThan(publicationsBeforeDisconnect);

    sessions.dispose();
  });

  it("rejects an older pane's pull-request result", () => {
    const sessions = createTestSessionCapability(
      createGatewayHarness({} as GatewayBrowserClient).gateway,
    );
    const key = "agent:main:shared-session";
    const olderEpoch = sessions.capturePullRequestEpoch(key);
    const newerEpoch = sessions.capturePullRequestEpoch(key);

    sessions.setPullRequestSummary(key, { numbers: [111532], state: "draft" }, newerEpoch);
    sessions.setPullRequestSummary(key, undefined, olderEpoch);

    expect(sessions.pullRequestSummary(key)).toEqual({ numbers: [111532], state: "draft" });
    sessions.dispose();
  });

  it("retires pull-request state when a session is deleted", async () => {
    const key = "agent:main:deleted-pr";
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        return { ok: true, deleted: true };
      }
      if (method === "sessions.list") {
        return sessionsResult([]);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createTestSessionCapability(
      createGatewayHarness({ request } as unknown as GatewayBrowserClient).gateway,
    );
    const epoch = sessions.capturePullRequestEpoch(key);
    sessions.setPullRequestSummary(key, { numbers: [111532], state: "open" }, epoch);

    await expect(sessions.delete(key)).resolves.toEqual({ deleted: true });
    expect(sessions.pullRequestSummary(key)).toBeUndefined();

    sessions.setPullRequestSummary(key, { numbers: [111532], state: "open" }, epoch);
    expect(sessions.pullRequestSummary(key)).toBeUndefined();
    sessions.dispose();
  });
});

const sharedPublisher = { source: "system-configured" as const, accountId: 1, login: "system-bot" };
function publicationHarness() {
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === "sessions.github.options") {
      return { shared: sharedPublisher, personal: null, pendingPersonal: null };
    }
    if (method === "sessions.github.publish") {
      throw new Error("Response lost");
    }
    if (method === "sessions.list") {
      return sessionsResult([]);
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const harness = createGatewayHarness(createTestGatewayClient(request));
  const sessions = createTestSessionCapability(harness.gateway);
  onTestFinished(() => sessions.dispose());
  const row = (id: string): GatewaySessionRow => ({
    key: `agent:main:${id}`,
    kind: "direct",
    sessionId: id,
    updatedAt: 1,
  });
  const attach = (session = row("publication")) => {
    const binding = sessions.githubPublication.attach(session, vi.fn())!;
    binding.sync({
      canWrite: true,
      personalReady: true,
      isPresented: () => true,
      isCurrent: () => binding.matches(session),
    });
    onTestFinished(() => binding.detach());
    return binding;
  };
  return { ...harness, request, sessions, row, attach };
}
async function publicationSettled(binding: GitHubPublicationBinding) {
  await vi.waitFor(() => expect(binding.view()?.busy).toBe(false));
  return binding.view()!;
}
const publishedResult = {
  requestId: "bdca439a-e787-4f9f-b5f3-a878c662cc77",
  publisher: sharedPublisher,
  status: "published",
  url: "https://github.com/team/demo/pull/1",
  repository: "team/demo",
  branch: "feature/one",
  headCommit: "a".repeat(40),
};

describe("application-owned publication custody", () => {
  it.each(["not-deleted", "rejected", "confirmed"] as const)(
    "keeps publication custody until a pending deletion is %s",
    async (outcome) => {
      const { attach, request, row, sessions } = publicationHarness();
      const session = row("publication");
      request.mockResolvedValueOnce(sessionsResult([session]));
      await sessions.refresh({ force: true });
      const first = attach(session);
      const ready = await publicationSettled(first);
      const publication = createDeferred<unknown>();
      request.mockImplementationOnce(() => publication.promise);
      ready.onPublish?.();
      const original = request.mock.calls.at(-1);
      const deletion = createDeferred<{ deleted: boolean }>();
      request.mockImplementationOnce(() => deletion.promise);
      const removal = sessions.delete(session.key, { expectedSessionId: session.sessionId }).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
      expect(sessions.deletionState(session.key)).toBe("pending");
      publication.reject(new Error("Publication response lost"));
      // Let the publication response settle while the independent deletion is still pending.
      await nextTurn();
      expect(first.view()).toBeUndefined();
      ready.onPublish?.();
      ready.onRefresh();
      expect(request.mock.calls.filter(([method]) => method === "sessions.github.publish")).toEqual(
        [original],
      );
      first.detach();

      if (outcome === "rejected") {
        deletion.reject(new Error("Deletion failed"));
      } else {
        deletion.resolve({ deleted: outcome === "confirmed" });
      }
      const settled = await removal;
      if (outcome === "rejected") {
        expect(settled.error).toEqual(new Error("Deletion failed"));
      } else {
        expect(settled.value).toEqual({ deleted: outcome === "confirmed" });
      }
      const returned = attach(session);
      if (outcome === "confirmed") {
        expect(returned.view()).toBeUndefined();
      } else {
        const retry = await publicationSettled(returned);
        expect(retry.locked).toBe(true);
        retry.onPublish?.();
        await publicationSettled(returned);
        expect(
          request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
        ).toEqual([original, original]);
      }
    },
  );

  it("shares idle bindings until the last detach and reloads options on return", async () => {
    const { attach, request } = publicationHarness();
    const first = attach();
    await publicationSettled(first);
    const second = attach();
    await publicationSettled(second);
    expect(request).toHaveBeenCalledTimes(1);

    first.detach();
    first.detach();
    second.view()?.onRefresh();
    await publicationSettled(second);
    expect(request).toHaveBeenCalledTimes(2);

    second.detach();
    const replacementPublisher = { ...sharedPublisher, accountId: 3, login: "replacement-bot" };
    request.mockResolvedValueOnce({
      shared: replacementPublisher,
      personal: null,
      pendingPersonal: null,
    });
    const returned = attach();
    expect((await publicationSettled(returned)).selection).toEqual({
      source: "shared",
      expected: replacementPublisher,
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each(["unknown", "published"] as const)(
    "keeps a late %s outcome after every presentation detaches",
    async (outcome) => {
      const { attach, request, sessions } = publicationHarness();
      const first = attach();
      const ready = await publicationSettled(first);
      const response = createDeferred<unknown>();
      request.mockImplementationOnce(() => response.promise);
      ready.onPublish?.();
      const original = request.mock.calls.at(-1);
      first.detach();
      ready.onPublish?.();
      ready.onRefresh();
      ready.onSelect?.("personal");
      expect(request).toHaveBeenCalledTimes(2);
      // An empty filtered roster cannot retire an admitted operation.
      await sessions.list();
      if (outcome === "unknown") {
        response.reject(new Error("Response lost"));
      } else {
        response.resolve(publishedResult);
      }
      const returned = attach();
      const view = await publicationSettled(returned);
      if (outcome === "unknown") {
        expect(view.locked).toBe(true);
        expect(view.selection).toEqual({ source: "shared", expected: sharedPublisher });
        view.onPublish?.();
        await publicationSettled(returned);
        expect(
          request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
        ).toEqual([original, original]);
      } else {
        expect(view.result).toEqual(publishedResult);
        expect(view.onNewAction).toBeTypeOf("function");
      }
    },
  );

  it("refuses excess initial invocations while preserving all original retries until explicit acknowledgement", async () => {
    const { attach, request, row } = publicationHarness();
    for (let index = 0; index < 32; index += 1) {
      const binding = attach(row(`capacity-${index}`));
      (await publicationSettled(binding)).onPublish?.();
      await publicationSettled(binding);
      binding.detach();
    }
    const full = attach(row("capacity-32"));
    (await publicationSettled(full)).onPublish?.();
    expect((await publicationSettled(full)).error).toContain("publications are awaiting review");
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
    ).toHaveLength(32);
    const original = request.mock.calls.find(([method]) => method === "sessions.github.publish");
    const retained = attach(row("capacity-0"));
    request.mockResolvedValueOnce(publishedResult);
    (await publicationSettled(retained)).onPublish?.();
    const terminal = await publicationSettled(retained);
    expect(request.mock.calls.at(-1)).toEqual(original);
    full.view()?.onPublish?.();
    expect((await publicationSettled(full)).error).toContain("publications are awaiting review");
    terminal.onNewAction?.();
    await publicationSettled(retained);
    full.view()?.onPublish?.();
    await publicationSettled(full);
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
    ).toHaveLength(34);
  });

  it.each([
    "disconnect",
    "profile",
    "access",
    "archive",
    "participation",
    "incarnation",
    "delete",
  ] as const)(
    "retires a detached operation after %s and rejects its late outcome",
    async (change) => {
      const { attach, request, row, publish, update, emitEvent } = publicationHarness();
      const first = attach();
      const ready = await publicationSettled(first);
      const response = createDeferred<unknown>();
      request.mockImplementationOnce(() => response.promise);
      ready.onPublish?.();
      first.detach();
      const session = row("publication");
      if (change === "disconnect") {
        publish(false);
        publish(true);
      } else if (change === "profile") {
        update({ selfUser: { id: "other", identity: { type: "profile", id: "other" } } });
      } else if (change === "access") {
        update({ hello: gatewayHelloForMethods(["sessions.github.publish"], ["operator.read"]) });
      } else {
        if (change === "archive") {
          session.archived = true;
        }
        if (change === "participation") {
          session.visibility = "draft";
          session.sharingRole = "viewer";
        }
        if (change === "incarnation") {
          session.sessionId = "replacement";
        }
        emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: {
            agentId: "main",
            reason: change === "delete" ? "delete" : "patch",
            session: { ...session, updatedAt: 2 },
          },
        });
      }
      response.resolve(publishedResult);
      ready.onPublish?.();
      ready.onRefresh();
      const returned = attach(session);
      if (change === "delete") {
        expect(returned.view()).toBeUndefined();
      } else {
        expect((await publicationSettled(returned)).result).toBeNull();
      }
      expect(
        request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
      ).toHaveLength(1);
    },
  );

  it("lets a replacement presentation observe the same operation without reviving detached callbacks", async () => {
    const { attach, request } = publicationHarness();
    const first = attach();
    (await publicationSettled(first)).onPublish?.();
    const unknown = await publicationSettled(first);
    const other = attach();
    first.detach();
    unknown.onPublish?.();
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
    ).toHaveLength(1);
    (await publicationSettled(other)).onPublish?.();
    await publicationSettled(other);
    const calls = request.mock.calls.filter(([method]) => method === "sessions.github.publish");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });
});

it("does not apply another agent's global-session permission event to a retained publication", async () => {
  const { attach, request, emitEvent } = publicationHarness();
  const own: GatewaySessionRow = {
    key: "global",
    agentId: "main",
    kind: "global",
    sessionId: "own-global",
    updatedAt: 1,
  };
  const binding = attach(own);
  (await publicationSettled(binding)).onPublish?.();
  const unknown = await publicationSettled(binding);
  const original = request.mock.calls.at(-1);
  binding.detach();
  emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: {
      agentId: "writer",
      reason: "patch",
      session: {
        key: "global",
        kind: "global",
        sessionId: "other-global",
        updatedAt: 2,
        visibility: "draft",
        sharingRole: "viewer",
      },
    },
  });
  const returned = attach(own);
  const retained = await publicationSettled(returned);
  expect(retained.locked).toBe(true);
  expect(retained.selection).toEqual(unknown.selection);
  retained.onPublish?.();
  await publicationSettled(returned);
  expect(request.mock.calls.filter(([method]) => method === "sessions.github.publish")).toEqual([
    original,
    original,
  ]);
});
