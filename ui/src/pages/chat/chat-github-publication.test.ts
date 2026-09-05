/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  GitHubPublicationController,
  type GitHubPublicationOptions,
  type GitHubPublicationPresentationBinding,
} from "../../lib/sessions/github-publication-controller.ts";

type GitHubPublicationScope = Parameters<GitHubPublicationPresentationBinding["sync"]>[0] & {
  client: Pick<GatewayBrowserClient, "request">;
  key: string;
  sessionKey: string;
};

const shared = { source: "system-configured" as const, accountId: 1, login: "system-bot" };
const account = { accountId: 2, login: "alice-tools" };
const generation = "bdca439a-e787-4f9f-b5f3-a878c662cc76";
const requestId = "bdca439a-e787-4f9f-b5f3-a878c662cc77";
const options: GitHubPublicationOptions = {
  shared,
  personal: {
    state: "connected",
    generation,
    account,
    accessExpiresAtMs: null,
    refreshState: "available",
    pending: null,
  },
  pendingPersonal: null,
};
const confirmation = {
  account,
  generation,
  requestDigest: "a".repeat(64),
  pushRepository: "alice/demo",
  repository: "team/demo",
  branch: "feature/one",
  baseBranch: "main",
  sourceHeadCommit: "1".repeat(40),
  sourceIndexTree: "2".repeat(40),
  workspaceTree: "3".repeat(40),
};
const interrupted = {
  result: {
    requestId,
    publisher: { source: "personal" as const, ...account },
    status: "needs_confirmation" as const,
    message: "Review the original publication.",
  },
  confirmation,
};

function setup(initialOptions = options) {
  const request = vi.fn().mockImplementation(async (method: string) => {
    if (method === "sessions.github.options") {
      return initialOptions;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const scope: GitHubPublicationScope = {
    client: { request },
    key: "gateway:alice:session:1",
    sessionKey: "agent:main:one",
    canWrite: true,
    personalReady: true,
    isPresented: () => true,
    isCurrent: () => true,
  };
  const changed = vi.fn();
  let current = scope;
  const create = (owner: GitHubPublicationScope) =>
    new GitHubPublicationController({
      client: owner.client,
      sessionKey: owner.sessionKey,
      isCurrent: () => current.key === owner.key && current.isCurrent(),
      reserve: () => {},
      release: () => {},
      unbound: () => {},
    });
  let operation = create(scope);
  let binding = operation.bind(changed);
  binding.sync(scope);
  const controller = {
    view: () => binding.view(),
    reset: () => operation.reset(),
    sync(next: GitHubPublicationScope) {
      if (next.key !== current.key) {
        binding.detach();
        operation.reset();
        current = next;
        operation = create(next);
        binding = operation.bind(changed);
      } else {
        current = next;
      }
      binding.sync(next);
    },
  };
  return { controller, request, scope, changed };
}
async function settled(controller: ReturnType<typeof setup>["controller"]) {
  await vi.waitFor(() => expect(controller.view()?.busy).toBe(false));
  return controller.view()!;
}

describe("explicit GitHub publication", () => {
  it("defaults to the displayed shared account; personal connection alone changes no default", async () => {
    const { controller, request } = setup();
    const view = await settled(controller);
    expect(view.selection).toEqual({ source: "shared", expected: shared });
    request.mockResolvedValueOnce({
      requestId,
      publisher: shared,
      status: "published",
      url: "https://github.com/team/demo/pull/1",
      repository: "team/demo",
      branch: "feature/one",
      headCommit: "a".repeat(40),
    });
    view.onPublish?.();
    await settled(controller);
    expect(request).toHaveBeenLastCalledWith("sessions.github.publish", {
      sessionKey: "agent:main:one",
      idempotencyKey: expect.any(String),
      selection: { source: "shared", expected: shared },
    });
  });

  it("freezes the exact personal generation/account and idempotency key across an unknown outcome", async () => {
    const { controller, request } = setup();
    (await settled(controller)).onSelect?.("personal");
    request.mockRejectedValueOnce(new Error("Response lost"));
    controller.view()?.onPublish?.();
    const unknown = await settled(controller);
    expect(unknown.locked).toBe(true);
    expect(unknown.error).toContain("Response lost");
    unknown.onSelect?.("shared");
    const first = request.mock.calls.at(-1);
    expect(first?.[1]).toMatchObject({ selection: { source: "personal", generation, account } });
    request.mockResolvedValueOnce({
      requestId,
      publisher: { source: "personal", ...account },
      status: "failed",
      code: "identity_changed",
      message: "Account changed",
      nextAction: "Review the selected account.",
    });
    controller.view()?.onPublish?.();
    const failed = await settled(controller);
    expect(request.mock.calls.at(-1)).toEqual(first);
    expect(failed.result?.publisher?.login).toBe("alice-tools");
    expect(failed.onPublish).toBeUndefined();
    expect(failed.onNewAction).toBeTypeOf("function");
  });

  it.each(["shared", "personal"] as const)(
    "releases only a rejected first %s invocation for a fresh explicit choice",
    async (source) => {
      const { controller, request } = setup();
      (await settled(controller)).onSelect?.(source);
      request.mockImplementationOnce(async (_method, params) => {
        throw new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "Review the current publisher.",
          details: {
            code: "GITHUB_PUBLICATION_SELECTION_REJECTED",
            idempotencyKey: params.idempotencyKey,
          },
        });
      });
      controller.view()?.onPublish?.();
      const rejected = await settled(controller);
      const first = request.mock.calls.at(-1)![1];
      expect(rejected).toMatchObject({
        locked: false,
        options: null,
        selection: null,
        error: "Review the current publisher.",
      });
      const next = {
        ...options,
        shared: { ...shared, accountId: 3, login: "new-shared" },
        personal: {
          ...options.personal!,
          account: { accountId: 4, login: "new-personal" },
          generation: "new-generation",
        },
      };
      request.mockResolvedValueOnce(next);
      rejected.onRefresh();
      const refreshed = await settled(controller);
      expect(
        request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
      ).toHaveLength(1);
      refreshed.onSelect?.(source);
      request.mockResolvedValueOnce({ requestId, status: "requested", message: "Accepted." });
      controller.view()?.onPublish?.();
      await settled(controller);
      const second = request.mock.calls.at(-1)![1];
      expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
      expect(second.selection).toEqual(
        source === "shared"
          ? { source, expected: next.shared }
          : { source, account: next.personal.account, generation: next.personal.generation },
      );
    },
  );

  it.each(["uncertain-retry", "wrong-key", "missing-key", "extra-field", "ordinary-error"])(
    "retains the exact attempt for %s instead of inferring admission from error prose",
    async (mode) => {
      const { controller, request } = setup();
      (await settled(controller)).onSelect?.("personal");
      const reject = async (_method: string, params: { idempotencyKey: string }) => {
        throw new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "GitHub publication identity changed.",
          ...(mode === "ordinary-error"
            ? {}
            : {
                details: {
                  code: "GITHUB_PUBLICATION_SELECTION_REJECTED",
                  ...(mode === "missing-key"
                    ? {}
                    : {
                        idempotencyKey: mode === "wrong-key" ? "other-key" : params.idempotencyKey,
                      }),
                  ...(mode === "extra-field" ? { admitted: true } : {}),
                },
              }),
        });
      };
      request.mockImplementationOnce(
        mode === "uncertain-retry"
          ? async () => {
              throw new Error(
                "Response lost while the original invocation may still be preparing.",
              );
            }
          : reject,
      );
      controller.view()?.onPublish?.();
      await settled(controller);
      const first = request.mock.calls.at(-1)![1];
      request.mockImplementationOnce(reject);
      controller.view()?.onPublish?.();
      const retained = await settled(controller);
      expect(retained.locked).toBe(true);
      expect(retained.onSelect).toBeUndefined();
      expect(retained.onNewAction).toBeUndefined();
      expect(request.mock.calls.at(-1)![1]).toEqual(first);
    },
  );

  it("discovers and explicitly confirms the original request after a cold connection", async () => {
    const { controller, request } = setup({ ...options, pendingPersonal: interrupted });
    const view = await settled(controller);
    expect(view.result).toEqual(interrupted.result);
    expect(view.confirmation).toEqual(confirmation);
    expect(view.onPublish).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce({
      requestId,
      publisher: { source: "personal", ...account },
      status: "published",
      url: "https://github.com/team/demo/pull/1",
      repository: "team/demo",
      branch: "feature/one",
      headCommit: "a".repeat(40),
    });
    view.onConfirm?.();
    await settled(controller);
    expect(request).toHaveBeenLastCalledWith("sessions.github.confirm", {
      sessionKey: "agent:main:one",
      requestId,
      generation,
      account,
      requestDigest: confirmation.requestDigest,
    });
    expect(request.mock.calls.some(([method]) => method === "sessions.github.publish")).toBe(false);
  });

  it("keeps a failed confirmation frozen until the server supplies a terminal outcome", async () => {
    const { controller, request } = setup({ ...options, pendingPersonal: interrupted });
    const view = await settled(controller);
    request.mockRejectedValueOnce(new Error("Confirmation response lost"));
    view.onConfirm?.();
    const unknown = await settled(controller);
    expect(unknown.locked).toBe(true);
    expect(unknown.onNewAction).toBeUndefined();
    expect(unknown.confirmation).toEqual(confirmation);
    request.mockResolvedValueOnce({
      ...interrupted,
      result: {
        ...interrupted.result,
        status: "failed",
        code: "workspace_changed",
        nextAction: "Review the workspace before creating a new publication.",
      },
      confirmation: null,
    });
    unknown.onRefresh();
    const failed = await settled(controller);
    expect(request).toHaveBeenLastCalledWith("sessions.github.status", {
      sessionKey: "agent:main:one",
      requestId,
    });
    expect(failed.onConfirm).toBeUndefined();
    expect(failed.onNewAction).toBeTypeOf("function");
  });

  it("lets the user review fresh choices after an incompatible discovered request without rediscovering it", async () => {
    const failed = {
      result: {
        ...interrupted.result,
        status: "failed" as const,
        code: "identity_changed" as const,
        nextAction: "Choose a new publication.",
      },
      confirmation: null,
    };
    const { controller, request } = setup({ ...options, pendingPersonal: failed });
    (await settled(controller)).onNewAction?.();
    const view = await settled(controller);
    expect(view.result).toBeNull();
    expect(view.selection).toEqual({ source: "shared", expected: shared });
    expect(request.mock.calls.some(([method]) => method === "sessions.github.publish")).toBe(false);
  });

  it("drops old options after an ownership change without exposing the old personal request", async () => {
    const { controller, request, scope } = setup();
    await settled(controller);
    let resolveOld!: (value: GitHubPublicationOptions) => void;
    request.mockImplementationOnce(
      () =>
        new Promise<GitHubPublicationOptions>((resolve) => {
          resolveOld = resolve;
        }),
    );
    controller.view()?.onRefresh();
    const nextOptions = {
      shared: { ...shared, login: "other-system" },
      personal: null,
      pendingPersonal: null,
    };
    request.mockResolvedValueOnce(nextOptions);
    controller.sync({ ...scope, key: "gateway:bob:session:2" });
    await settled(controller);
    resolveOld({ ...options, pendingPersonal: interrupted });
    await Promise.resolve();
    expect(controller.view()?.options).toEqual(nextOptions);
    expect(controller.view()?.result).toBeNull();
  });

  it("loads current options when a retained hidden pane becomes presented", async () => {
    const { controller, request, scope } = setup();
    await settled(controller);
    let presented = false;
    const retainedScope = { ...scope, isPresented: () => presented };
    controller.sync(retainedScope);
    expect(controller.view()).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce({ ...options, pendingPersonal: interrupted });
    presented = true;
    controller.sync(retainedScope);
    const visible = await settled(controller);
    expect(request).toHaveBeenCalledTimes(2);
    expect(visible.result).toEqual(interrupted.result);
    expect(visible.confirmation).toEqual(confirmation);
  });

  it.each(["published", "unknown", "selection-rejection"] as const)(
    "retains a %s response that arrives while the pane is hidden",
    async (outcome) => {
      const { controller, request, scope, changed } = setup();
      let presented = true;
      const retainedScope = { ...scope, isPresented: () => presented };
      controller.sync(retainedScope);
      const ready = await settled(controller);
      const response = createDeferred<unknown>();
      request.mockImplementationOnce(() => response.promise);
      ready.onPublish?.();
      const first = request.mock.calls.at(-1)![1];
      presented = false;
      controller.sync(retainedScope);
      changed.mockClear();
      if (outcome === "published") {
        response.resolve({ requestId, publisher: shared, status: "published" });
      } else {
        response.reject(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Publication response",
            ...(outcome === "selection-rejection"
              ? {
                  details: {
                    code: "GITHUB_PUBLICATION_SELECTION_REJECTED",
                    idempotencyKey: first.idempotencyKey,
                  },
                }
              : {}),
          }),
        );
      }
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
      controller.sync(retainedScope);
      expect(controller.view()).toBeUndefined();
      ready.onPublish?.();
      ready.onSelect?.("personal");
      ready.onRefresh();
      expect(request).toHaveBeenCalledTimes(2);
      presented = true;
      controller.sync(retainedScope);
      const visible = await settled(controller);
      expect(request).toHaveBeenCalledTimes(2);
      if (outcome === "published") {
        expect(visible.result).toMatchObject({ requestId, publisher: shared, status: "published" });
        presented = false;
        visible.onNewAction?.();
        presented = true;
        expect(controller.view()?.result).toEqual(visible.result);
      } else {
        expect(visible.error).toContain("Publication response");
        expect(visible.locked).toBe(outcome === "unknown");
        expect(visible.selection).toEqual(outcome === "unknown" ? first.selection : null);
      }
    },
  );

  it.each(["result", "selection-rejection"])(
    "retires an old publication %s after reconnect without clearing the discovered request",
    async (outcome) => {
      const { controller, request, scope } = setup();
      (await settled(controller)).onSelect?.("personal");
      let resolveOld!: (value: unknown) => void;
      let rejectOld!: (error: unknown) => void;
      request.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            resolveOld = resolve;
            rejectOld = reject;
          }),
      );
      controller.view()?.onPublish?.();
      const first = request.mock.calls.at(-1)![1];
      controller.reset();
      request.mockResolvedValueOnce({ ...options, pendingPersonal: interrupted });
      controller.sync({ ...scope, key: "gateway:alice:session:2" });
      await settled(controller);
      if (outcome === "result") {
        resolveOld({
          requestId,
          status: "published",
          publisher: { source: "personal", ...account },
        });
      } else {
        rejectOld(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Old selection rejected.",
            details: {
              code: "GITHUB_PUBLICATION_SELECTION_REJECTED",
              idempotencyKey: first.idempotencyKey,
            },
          }),
        );
      }
      await Promise.resolve();
      expect(controller.view()?.result?.status).toBe("needs_confirmation");
      expect(
        request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
      ).toHaveLength(1);
    },
  );

  it("offers shared publication without a personal owner and never auto-selects personal when shared is absent", async () => {
    const unbound = setup({ shared, personal: null, pendingPersonal: null });
    expect((await settled(unbound.controller)).selection).toEqual({
      source: "shared",
      expected: shared,
    });
    const personalOnly = setup({ ...options, shared: null });
    expect((await settled(personalOnly.controller)).selection).toBeNull();
    personalOnly.controller.view()?.onSelect?.("personal");
    expect(personalOnly.controller.view()?.selection).toEqual({
      source: "personal",
      account,
      generation,
    });
  });

  it("keeps readers nonmutating and personal publication unavailable on busy or remote workspaces", async () => {
    const { controller, request, scope } = setup();
    await settled(controller);
    controller.sync({ ...scope, key: "reader", canWrite: false });
    const reader = await settled(controller);
    expect(reader.onSelect).toBeUndefined();
    expect(reader.onPublish).toBeUndefined();
    controller.sync({ ...scope, key: "remote", personalReady: false });
    (await settled(controller)).onSelect?.("personal");
    controller.view()?.onPublish?.();
    expect(request.mock.calls.some(([method]) => method === "sessions.github.publish")).toBe(false);
    controller.view()?.onSelect?.("shared");
    request.mockResolvedValueOnce({
      requestId,
      status: "requested",
      publisher: shared,
      message: "Waiting for reconciliation.",
    });
    controller.view()?.onPublish?.();
    await settled(controller);
    expect(request).toHaveBeenLastCalledWith(
      "sessions.github.publish",
      expect.objectContaining({ selection: { source: "shared", expected: shared } }),
    );
  });
});

describe("publication action observation", () => {
  it("does not let an old terminal acknowledgement release a newer uncertain attempt", async () => {
    const { controller, request } = setup();
    request.mockResolvedValueOnce({ requestId, status: "published", publisher: shared });
    (await settled(controller)).onPublish?.();
    const terminal = await settled(controller);
    terminal.onNewAction?.();
    const next = await settled(controller);
    request.mockRejectedValueOnce(new Error("Response lost"));
    next.onPublish?.();
    const unknown = await settled(controller);
    const calls = request.mock.calls.length;
    terminal.onNewAction?.();
    expect(controller.view()).toMatchObject({
      locked: true,
      error: unknown.error,
      selection: unknown.selection,
    });
    expect(request).toHaveBeenCalledTimes(calls);
    controller.view()?.onPublish?.();
    await settled(controller);
    const publications = request.mock.calls.filter(
      ([method]) => method === "sessions.github.publish",
    );
    expect(publications.at(-1)).toEqual(publications.at(-2));
  });

  it("does not let a saved confirmation confirm a different publication", async () => {
    const { controller, request } = setup({ ...options, pendingPersonal: interrupted });
    const original = await settled(controller);
    request.mockResolvedValueOnce({
      requestId,
      status: "published",
      publisher: { source: "personal", ...account },
    });
    original.onConfirm?.();
    const terminal = await settled(controller);
    request.mockResolvedValueOnce(options);
    terminal.onNewAction?.();
    (await settled(controller)).onSelect?.("personal");
    const next = {
      ...interrupted,
      result: { ...interrupted.result, requestId: "bdca439a-e787-4f9f-b5f3-a878c662cc78" },
      confirmation: { ...confirmation, requestDigest: "b".repeat(64) },
    };
    request.mockResolvedValueOnce(next.result).mockResolvedValueOnce(next);
    controller.view()?.onPublish?.();
    const reviewed = await settled(controller);
    expect(reviewed.confirmation).toEqual(next.confirmation);
    const calls = request.mock.calls.length;
    original.onConfirm?.();
    expect(request).toHaveBeenCalledTimes(calls);
    request.mockResolvedValueOnce({ ...next.result, status: "requested" });
    reviewed.onConfirm?.();
    await settled(controller);
    expect(request).toHaveBeenLastCalledWith(
      "sessions.github.confirm",
      expect.objectContaining({
        requestId: next.result.requestId,
        requestDigest: next.confirmation.requestDigest,
      }),
    );
  });
});
