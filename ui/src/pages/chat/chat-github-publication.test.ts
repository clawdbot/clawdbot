/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import {
  GitHubPublicationController,
  type GitHubPublicationOptions,
  type GitHubPublicationScope,
} from "./chat-github-publication.ts";

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
    isCurrent: () => true,
  };
  const controller = new GitHubPublicationController(vi.fn());
  controller.sync(scope);
  return { controller, request, scope };
}
async function settled(controller: GitHubPublicationController) {
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
    const retainedScope = { ...scope, isCurrent: () => presented };
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

  it("retires an in-flight publication on reset and discovers the same owner's request on reconnect", async () => {
    const { controller, request, scope } = setup();
    (await settled(controller)).onSelect?.("personal");
    let resolveOld!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    controller.view()?.onPublish?.();
    controller.reset();
    request.mockResolvedValueOnce({ ...options, pendingPersonal: interrupted });
    controller.sync({ ...scope, key: "gateway:alice:session:2" });
    await settled(controller);
    resolveOld({ requestId, status: "published", publisher: { source: "personal", ...account } });
    await Promise.resolve();
    expect(controller.view()?.result?.status).toBe("needs_confirmation");
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
    ).toHaveLength(1);
  });

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
