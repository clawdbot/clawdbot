/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlUiAction } from "../../../../src/plugin-sdk/control-ui.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { registerSessionPluginAction } from "../../test-helpers/control-ui-plugin-action.ts";
import {
  createContext,
  createGateway,
  createManagedSessions,
  createRenderedPage,
  createSessions,
} from "./sessions-page.test-support.ts";

type TestSessionMenu = HTMLElement & {
  pluginActions: readonly { id: string; label: string; disabled?: boolean }[];
  readonly updateComplete: Promise<boolean>;
};

async function createPluginSessionMenuPage() {
  const row: GatewaySessionRow = {
    key: "agent:main:review",
    kind: "direct",
    sessionId: "review-id",
    label: "Ready",
    updatedAt: 1,
  };
  const managed = createManagedSessions();
  managed.sessions.state.result = sessionsResult([{ ...row, label: "Primary roster" }], 1);
  const context = createContext(
    createGateway({} as GatewayBrowserClient).gateway,
    managed.sessions,
  );
  const run = vi.fn<ControlUiAction["run"]>();
  const { entry } = registerSessionPluginAction(context, {
    id: "review",
    label: "Review session",
    placement: "session",
    resolve: ({ session }) => ({
      label: `Review ${session?.label}`,
      hidden: session?.archived === true,
      disabled: session?.hasActiveRun === true,
    }),
    run,
  });
  const page = await createRenderedPage(context, sessionsResult([row], 1), "all");
  const [query] = managed.subscribeList.mock.calls[0]!;
  const publish = (rows: GatewaySessionRow[]) => {
    managed.publish(query, {
      result: sessionsResult(rows, 2),
      agentId: "main",
      loading: false,
      error: null,
    });
  };
  const openMenu = async () => {
    page.openSessionMenu(row, { x: 10, y: 20 }, document.createElement("button"));
    await page.updateComplete;
    const menu = page.querySelector<TestSessionMenu>("openclaw-session-menu")!;
    expect(menu).not.toBeNull();
    await menu.updateComplete;
    return menu;
  };
  return { page, row, run, publish, openMenu, actionSelector: `[value="plugin:${entry.key}"]` };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("sessions page plugin actions", () => {
  it("projects plugin-owned labels and disabled state into a session menu", async () => {
    const row = { key: "agent:main:review", kind: "direct" } as GatewaySessionRow;
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const context = createContext(gateway, createSessions());
    const resolve = vi.fn(() => ({ label: "Open review", disabled: true }));
    const run = vi.fn();
    const { entry } = registerSessionPluginAction(context, {
      id: "review",
      label: "Create review",
      placement: "session",
      resolve,
      run,
    });
    const page = await createRenderedPage(context, {
      count: 1,
      sessions: [row],
    } as SessionsListResult);
    page.openSessionMenu(row, { x: 10, y: 20 }, document.createElement("button"));
    await page.updateComplete;
    const menu = page.querySelector<TestSessionMenu>("openclaw-session-menu")!;
    await menu.updateComplete;
    expect(resolve).toHaveBeenCalledWith({ sessionKey: row.key, session: row });
    expect(menu.pluginActions).toEqual([{ id: entry.key, label: "Open review", disabled: true }]);
    expect(menu.querySelector(`[value="plugin:${entry.key}"]`)?.hasAttribute("disabled")).toBe(
      true,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("uses current scoped session state when invoking plugin menu actions", async () => {
    const { page, row, run, publish, openMenu, actionSelector } =
      await createPluginSessionMenuPage();
    let menu = await openMenu();
    const current = { ...row, label: "Latest" };

    // Keep the old menu mounted while the scoped roster publishes a new row.
    publish([current]);
    menu.querySelector<HTMLElement>(actionSelector)!.click();
    expect(run.mock.calls.length).toBe(1);
    expect(run.mock.calls[0]![0].sessionKey).toBe(row.key);
    expect(run.mock.calls[0]![0].session).toEqual(current);
    await page.updateComplete;

    menu = await openMenu();
    publish([{ ...current, hasActiveRun: true }]);
    menu.querySelector<HTMLElement>(actionSelector)!.click();
    expect(run.mock.calls.length).toBe(1);
    await vi.waitFor(() => expect(page.textContent).toContain("Reopen the session menu."));

    publish([{ ...current, archived: true }]);
    await page.updateComplete;
    expect((await openMenu()).pluginActions).toEqual([]);
  });

  it("does not invoke a plugin for a removed or replaced menu session", async () => {
    const { page, row, run, publish, openMenu, actionSelector } =
      await createPluginSessionMenuPage();
    const replacement = { ...row, sessionId: "replacement-id", label: "Replacement" };
    for (const rows of [[], [replacement]]) {
      publish([row]);
      await page.updateComplete;
      const menu = await openMenu();
      publish(rows);
      menu.querySelector<HTMLElement>(actionSelector)!.click();
      expect(run.mock.calls.length).toBe(0);
      await vi.waitFor(() => expect(page.textContent).toContain("Reopen the session menu."));
    }

    publish([row]);
    await page.updateComplete;
    const menu = await openMenu();
    publish([replacement]);
    await page.updateComplete;
    await menu.updateComplete;
    expect(page.querySelector(actionSelector)).toBeNull();
  });

  it.each(["disconnect", "detach"])("revokes plugin navigation after %s", async (ending) => {
    const pending = createDeferred();
    const mutableGateway = createGateway({} as GatewayBrowserClient);
    const context = createContext(mutableGateway.gateway, createSessions());
    const run = vi.fn(
      async ({ host, sessionKey, session }: Parameters<ControlUiAction["run"]>[0]) => {
        await pending.promise;
        host.sessions.open({ sessionKey, agentId: session?.agentId });
      },
    );
    const { entry, open } = registerSessionPluginAction(context, {
      id: "review",
      label: "Open review",
      placement: "session",
      run,
    });
    const row = {
      key: "agent:main:review",
      kind: "direct",
      sessionId: "review-id",
    } as GatewaySessionRow;
    const page = await createRenderedPage(context, sessionsResult([row], 1));
    const request = page.runPluginAction(entry.key, row);
    expect(run).toHaveBeenCalledOnce();
    if (ending === "disconnect") {
      mutableGateway.emit({ phase: "reconnecting" });
    } else {
      page.remove();
    }
    pending.resolve();
    await request;
    expect(open).not.toHaveBeenCalled();
    expect(page.error).toBeNull();
  });
});
