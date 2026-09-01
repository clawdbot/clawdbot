import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  type SidebarLifecycleState,
  type TestSessionMenu,
} from "../app-sidebar.ts";
import {
  answerConfirmDialog,
  installDialogPolyfill,
  waitForConfirmDialogActions,
} from "../modal-dialog.ts";
import { waitForFast } from "../wait-for.ts";

async function openSessionMenu(sidebar: SidebarLifecycleState, key: string) {
  const button = sidebar.querySelector<HTMLButtonElement>(
    `[data-session-key="${key}"] [data-session-menu="true"]`,
  );
  if (!button) {
    throw new Error(`expected menu button for ${key}`);
  }
  button.click();
  await sidebar.updateComplete;
  const menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
  if (!menu) {
    throw new Error("expected session menu");
  }
  await menu.updateComplete;
  return menu;
}

describe("AppSidebar session delete access", () => {
  it("keeps preserved worktrees when the operator lacks admin access", async () => {
    const request = vi.fn(() => Promise.resolve({}));
    const gateway = createGatewayHarness({
      request,
    } as unknown as GatewayBrowserClient);
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:a",
      "agent:main:b",
    ]);
    const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
    sidebar.connected = true;
    const result = harness.sessions.state.result;
    const archived = result?.sessions.find((row) => row.key === "agent:main:a");
    if (!result || !archived) {
      throw new Error("expected archived session fixture");
    }
    archived.archived = true;
    Object.assign(sidebar, { sessionsStatusFilter: "archived" });
    harness.publishList({ result });
    gateway.publish({
      hello: {
        auth: { role: "operator", scopes: ["operator.write"] },
        features: { methods: ["sessions.delete", "worktrees.remove"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await sidebar.updateComplete;
    harness.deleteSession.mockResolvedValueOnce({
      deleted: true,
      worktreePreserved: {
        id: "wt-1",
        branch: "feature",
        path: "/tmp/worktree",
        reason: "owner-mismatch",
      },
    });
    const restoreDialogPolyfill = installDialogPolyfill();
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    try {
      const menu = await openSessionMenu(sidebar, archived.key);
      menu.querySelector<HTMLButtonElement>('[data-shortcut="d"]')?.click();
      answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
      await waitForFast(() => expect(harness.deleteSession).toHaveBeenCalledOnce());
      await waitForFast(() => expect(alertSpy).toHaveBeenCalledOnce());

      expect(alertSpy).toHaveBeenCalledWith("Managed Worktrees:\nfeature — owned elsewhere");

      expect(request).not.toHaveBeenCalledWith("worktrees.remove", expect.anything());
    } finally {
      restoreDialogPolyfill();
      alertSpy.mockRestore();
    }
  });
});
