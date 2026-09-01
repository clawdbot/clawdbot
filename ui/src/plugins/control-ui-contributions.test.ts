import type { LitElement } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlUiAction } from "../../../src/plugin-sdk/control-ui.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import { createAgentSelectionCapability } from "../app/agent-selection.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import {
  createGatewayHarness,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createControlUiPluginHost } from "./control-ui-host.ts";
import type { ControlUiPluginOwner, ControlUiPluginRuntime } from "./control-ui-runtime.ts";
import "./control-ui-contributions.ts";

type ContributionsElement = LitElement & {
  kind: "header" | "composer";
  sessionKey: string;
  agentId?: string;
  presented: boolean;
};
const sessionKey = "agent:main:main";
const cleanups: (() => void)[] = [];

afterEach(() => {
  document.body.replaceChildren();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

async function mountActions(
  options: {
    placement?: "header" | "composer";
    session?: GatewaySessionRow;
    agentId?: string;
  } = {},
) {
  const request = vi.fn().mockResolvedValue({ ok: true });
  const client = { request } as unknown as GatewayBrowserClient;
  const { gateway: gatewayHarness } = createGatewayHarness(client);
  const setSessionKey = vi.fn();
  const gateway = Object.assign(gatewayHarness, { setSessionKey });
  const navigate = vi.fn();
  const agents = createAgentCapability(gateway);
  const agentSelection = createAgentSelectionCapability(
    { ...gateway, connection: { gatewayUrl: "ws://fixture.invalid" } },
    agents,
  );
  const sessions = createSessionCapability(gateway);
  const session: GatewaySessionRow = options.session ?? {
    key: sessionKey,
    kind: "direct",
    updatedAt: 1,
    label: "Ready",
  };
  sessions.reconcile(session, undefined, { resultAgentId: session.agentId });
  const abort = new AbortController();
  const pluginListeners = new Set<() => void>();
  let registered = true;
  const run = vi.fn<ControlUiAction["run"]>();
  const resolve = vi.fn<NonNullable<ControlUiAction["resolve"]>>(({ session: currentSession }) => ({
    label: `Review ${currentSession?.label ?? "unavailable"}`,
    hidden: currentSession?.archived === true,
    disabled: currentSession?.hasActiveRun === true,
  }));
  const action: ControlUiAction = {
    id: "review",
    label: "Review session",
    placement: options.placement ?? "header",
    resolve,
    run,
  };
  const plugins = {
    registrations: () =>
      registered
        ? [
            {
              key: "fixture/review",
              pluginId: "fixture",
              value: action,
              host,
              signal: abort.signal,
            },
          ]
        : [],
    subscribe: (listener: () => void) => {
      pluginListeners.add(listener);
      return () => pluginListeners.delete(listener);
    },
    reportError: vi.fn(),
    isCurrent: () => !abort.signal.aborted,
  } as unknown as ControlUiPluginRuntime;
  const context = {
    basePath: "",
    gateway,
    agents,
    agentSelection,
    sessions,
    plugins,
    navigate,
  } as unknown as ApplicationContext<RouteId>;
  const owner = {
    abort,
    client,
    descriptor: { pluginId: "fixture" },
    disposers: new Set(),
  } as Omit<ControlUiPluginOwner, "host">;
  const host = createControlUiPluginHost(() => context, plugins, owner);
  const provider = createApplicationContextProvider(context);
  const element = document.createElement("openclaw-plugin-contributions") as ContributionsElement;
  element.kind = options.placement ?? "header";
  element.sessionKey = session.key;
  element.agentId = options.agentId;
  cleanups.push(() => {
    abort.abort();
    agents.dispose();
    sessions.dispose();
  });
  provider.append(element);
  document.body.append(provider);
  await element.updateComplete;
  return {
    element,
    sessions,
    run,
    resolve,
    request,
    navigate,
    setSessionKey,
    unregister: () => {
      registered = false;
      for (const listener of pluginListeners) {
        listener();
      }
    },
  };
}

describe("native plugin session actions", () => {
  it.each(["header", "composer"] as const)(
    "keeps %s metadata scoped to its pane agent when the global key is shared",
    async (placement) => {
      const { element, sessions, run, resolve, request } = await mountActions({
        placement,
        agentId: "writer",
        session: { key: "global", kind: "global", agentId: "main", updatedAt: 1, label: "Main" },
      });
      const button = () => element.querySelector<HTMLButtonElement>("button");
      expect(button()?.textContent?.trim()).toBe("Review unavailable");
      button()?.click();
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.[0].session).toBeUndefined();
      expect(resolve).toHaveBeenLastCalledWith({
        sessionKey: "global",
        agentId: "writer",
        session: undefined,
      });
      expect(run.mock.calls[0]?.[0]).toMatchObject({ sessionKey: "global", agentId: "writer" });

      request.mockResolvedValueOnce(
        sessionsResult(
          [{ key: "global", kind: "global", agentId: "writer", updatedAt: 2, label: "Writer" }],
          2,
        ),
      );
      await sessions.refreshReplacement("writer");
      await element.updateComplete;
      expect(button()?.textContent?.trim()).toBe("Review Writer");
      button()?.click();
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1]?.[0].session).toMatchObject({
        key: "global",
        agentId: "writer",
        label: "Writer",
      });
    },
  );

  it.each(["header", "composer"] as const)(
    "retires a %s invocation when only its pane agent changes",
    async (placement) => {
      const { element, run, request } = await mountActions({
        placement,
        agentId: "main",
        session: { key: "global", kind: "global", agentId: "main", updatedAt: 1, label: "Main" },
      });
      element.querySelector<HTMLButtonElement>("button")?.click();
      const invocation = run.mock.calls[0]?.[0];
      if (!invocation) {
        throw new Error("Expected the pane's plugin action to run");
      }
      expect(invocation.session).toMatchObject({ key: "global", agentId: "main" });
      await invocation.host.request("fixture.current-owner");

      element.agentId = "writer";
      expect(invocation.signal.aborted).toBe(true);
      await expect(invocation.host.request("fixture.retired-owner")).rejects.toThrow(
        "view has ended",
      );
      expect(request.mock.calls.filter(([method]) => method === "fixture.retired-owner")).toEqual(
        [],
      );
      await element.updateComplete;
    },
  );

  it.each(["header", "composer"] as const)(
    "retires a hidden %s action across a same-turn hide/show and admits a fresh action",
    async (placement) => {
      const { element, run, navigate, setSessionKey } = await mountActions({ placement });
      const destination = { sessionKey: "agent:writer:resumed", agentId: "writer" };
      const release = createDeferred();
      run.mockImplementationOnce(async ({ host }) => {
        await release.promise;
        host.sessions.open(destination);
      });
      const retained = element.querySelector<HTMLButtonElement>("button")!;
      retained.click();
      const invocation = run.mock.calls[0]?.[0];
      if (!invocation) {
        throw new Error("Expected the visible plugin action to run");
      }
      const pending = Promise.resolve(run.mock.results[0]?.value);

      // Neither a retained button nor an immediate reshow revives the old action.
      element.presented = false;
      retained.click();
      element.presented = true;
      release.resolve();
      const completionError = await pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(navigate).not.toHaveBeenCalled();
      expect(setSessionKey).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledOnce();
      expect(invocation.signal.aborted).toBe(true);
      expect(completionError).toMatchObject({ message: "This plugin UI view has ended." });
      expect(() => invocation.host.sessions.open(destination)).toThrow("view has ended");
      await element.updateComplete;
      expect(element.querySelector('[role="alert"]')).toBeNull();

      run.mockImplementationOnce(({ host }) => {
        host.sessions.open(destination);
      });
      retained.click();
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1]?.[0].signal.aborted).toBe(false);
      expect(setSessionKey).toHaveBeenCalledExactlyOnceWith(destination.sessionKey);
      expect(navigate).toHaveBeenCalledOnce();
      expect(navigate.mock.calls[0]?.[0]).toBe("chat");
      expect(invocation.signal.aborted).toBe(true);
    },
  );

  it("revokes a removed action before its pending render", async () => {
    const { element, run, unregister } = await mountActions();
    const retained = element.querySelector<HTMLButtonElement>("button")!;
    unregister();
    retained.click();
    expect(run.mock.calls.length).toBe(0);
    await element.updateComplete;
    expect(element.querySelector("button")).toBeNull();
  });

  it.each(["header", "composer"] as const)(
    "updates %s action presentation and retires hidden invocations",
    async (placement) => {
      const { element, sessions, run, navigate, setSessionKey } = await mountActions({ placement });
      const button = () => element.querySelector<HTMLButtonElement>("button");
      expect(button()?.textContent?.trim()).toBe("Review Ready");
      expect(button()?.disabled).toBe(false);
      const pending = createDeferred();
      run.mockImplementationOnce(async ({ host }) => {
        await pending.promise;
        host.sessions.open({ sessionKey: "agent:writer:resumed", agentId: "writer" });
      });
      button()?.click();
      const invocation = run.mock.calls[0]?.[0];
      if (!invocation) {
        throw new Error("Expected the visible action to run");
      }
      const completion = Promise.resolve(run.mock.results[0]?.value).then(
        () => undefined,
        (error: unknown) => error,
      );

      sessions.patchRowLocal(sessionKey, { label: "Busy", hasActiveRun: true });
      await element.updateComplete;
      expect(button()?.textContent?.trim()).toBe("Review Busy");
      expect(button()?.disabled).toBe(true);
      expect(invocation.signal.aborted).toBe(false);

      sessions.patchRowLocal(sessionKey, { archived: true });
      const hiddenBeforeRender = invocation.signal.aborted;
      pending.resolve();
      const completionError = await completion;
      expect(hiddenBeforeRender).toBe(true);
      expect(navigate).not.toHaveBeenCalled();
      expect(setSessionKey).not.toHaveBeenCalled();
      expect(completionError).toMatchObject({ message: "This plugin UI view has ended." });
      await element.updateComplete;
      expect(button()).toBeNull();

      sessions.patchRowLocal(sessionKey, {
        label: "Resumed",
        archived: false,
        hasActiveRun: false,
      });
      await element.updateComplete;
      const retained = button()!;
      expect(retained.textContent?.trim()).toBe("Review Resumed");
      expect(retained.disabled).toBe(false);
      expect(invocation.signal.aborted).toBe(true);

      element.remove();
      sessions.patchRowLocal(sessionKey, { label: "Detached", hasActiveRun: true });
      await element.updateComplete;
      expect(retained.textContent?.trim()).toBe("Review Resumed");
      expect(retained.disabled).toBe(false);
      retained.click();
      expect(run.mock.calls.length).toBe(1);
    },
  );

  it("rechecks eligibility and passes the current session before a pending render", async () => {
    const { element, sessions, run, request } = await mountActions();
    const button = () => element.querySelector<HTMLButtonElement>("button")!;

    // Click in the same turn as publication, before Lit can update the old button.
    sessions.patchRowLocal(sessionKey, { hasActiveRun: true });
    button().click();
    expect(run.mock.calls.length).toBe(0);
    await element.updateComplete;

    sessions.patchRowLocal(sessionKey, { hasActiveRun: false });
    await element.updateComplete;
    sessions.patchRowLocal(sessionKey, { archived: true });
    button().click();
    expect(run.mock.calls.length).toBe(0);
    await element.updateComplete;

    sessions.patchRowLocal(sessionKey, { archived: false });
    await element.updateComplete;
    sessions.patchRowLocal(sessionKey, { label: "Latest" });
    button().click();
    expect(run.mock.calls.length).toBe(1);
    const invocation = run.mock.calls[0]![0];
    expect(invocation.sessionKey).toBe(sessionKey);
    expect(invocation.session).toMatchObject({
      key: sessionKey,
      label: "Latest",
      hasActiveRun: false,
      archived: false,
    });
    await invocation.host.request("fixture.current-action");
    expect(request).toHaveBeenCalledWith("fixture.current-action", {});
    await element.updateComplete;

    element.remove();
    expect(invocation.signal.aborted).toBe(true);
    await expect(invocation.host.request("fixture.retired-action")).rejects.toThrow(
      "view has ended",
    );
    expect(
      request.mock.calls.filter(([method]) => method === "fixture.retired-action"),
    ).toHaveLength(0);
  });
});
