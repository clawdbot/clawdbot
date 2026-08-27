import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { installDialogPolyfill, submitInputDialog, waitForInputDialog } from "../modal-dialog.ts";
import { waitForFast } from "../wait-for.ts";
import {
  click,
  mountMultiSelect,
  openContextMenu,
  rowLink,
  sessionMenu,
} from "./multi-select-support.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar new group dialog", () => {
  it("writes a new group catalog before assigning the selection through patchMany", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
    try {
      const { sidebar, harness } = await mountMultiSelect([
        "sessions.groups.put",
        "sessions.patchMany",
      ]);
      click(rowLink(sidebar, "agent:main:a"), { altKey: true });
      click(rowLink(sidebar, "agent:main:b"), { altKey: true });
      await sidebar.updateComplete;
      openContextMenu(sidebar, "agent:main:a");
      await sidebar.updateComplete;
      const menu = await sessionMenu(sidebar);
      menu.querySelector<HTMLElement>('wa-dropdown-item[value="new-group"]')?.click();

      // Opening the owned dialog is inert: nothing reaches the Gateway until a
      // name is submitted, and the submitted name is trimmed.
      await waitForInputDialog();
      expect(harness.groupsPut).not.toHaveBeenCalled();
      expect(harness.patchMany).not.toHaveBeenCalled();
      await submitInputDialog("  Projects  ");

      await waitForFast(() => expect(harness.patchMany).toHaveBeenCalledOnce());
      expect(harness.groupsPut).toHaveBeenCalledWith(["Projects"]);
      expect(harness.patchMany).toHaveBeenCalledWith(
        [
          { key: "agent:main:a", agentId: "main" },
          { key: "agent:main:b", agentId: "main" },
        ],
        { category: "Projects" },
      );
      expect(harness.groupsPut.mock.invocationCallOrder[0]).toBeLessThan(
        harness.patchMany.mock.invocationCallOrder[0]!,
      );
      expect(harness.patch).not.toHaveBeenCalled();
      await waitForFast(() => expect(harness.refreshReplacement).toHaveBeenCalledOnce());
    } finally {
      restoreDialogPolyfill();
    }
  });

  it("reports the skipped moves when selected rows leave the list mid-write", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    await toastHost.updateComplete;
    try {
      const { sidebar, harness } = await mountMultiSelect([
        "sessions.groups.put",
        "sessions.patchMany",
      ]);
      let landCatalogWrite!: () => void;
      harness.groupsPut.mockReturnValueOnce(
        new Promise((resolve) => {
          landCatalogWrite = () => resolve("completed");
        }),
      );
      click(rowLink(sidebar, "agent:main:a"), { altKey: true });
      click(rowLink(sidebar, "agent:main:b"), { altKey: true });
      await sidebar.updateComplete;
      openContextMenu(sidebar, "agent:main:a");
      await sidebar.updateComplete;
      const menu = await sessionMenu(sidebar);
      menu.querySelector<HTMLElement>('wa-dropdown-item[value="new-group"]')?.click();

      await waitForInputDialog();
      await submitInputDialog("Projects");
      await waitForFast(() => expect(harness.groupsPut).toHaveBeenCalledOnce());

      // Both rows leave the list while the catalog write is still in flight;
      // patching their keys now could recreate sessions that were removed.
      harness.publish({ result: { count: 0, sessions: [] } as unknown as SessionsListResult });
      landCatalogWrite();

      // The dialog is removed only once the submit chain has run to completion,
      // so waiting on that keeps the negative assertions below from passing
      // before the continuation has had a chance to patch anything.
      await waitForFast(() =>
        expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull(),
      );
      expect(harness.patchMany).not.toHaveBeenCalled();
      expect(harness.patch).not.toHaveBeenCalled();
      // The group landed and the moves did not: that partial outcome has to
      // reach the operator instead of closing as a plain success.
      expect(toastHost.querySelector(".app-toast__message")?.textContent).toBe(
        "Group created, but the move was skipped because the list changed. Move from the row menu.",
      );
    } finally {
      toastHost.remove();
      restoreDialogPolyfill();
    }
  });

  it("reports the partial outcome when only part of the selection leaves the list", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    await toastHost.updateComplete;
    try {
      const { sidebar, harness } = await mountMultiSelect([
        "sessions.groups.put",
        "sessions.patch",
        "sessions.patchMany",
      ]);
      let landCatalogWrite!: () => void;
      harness.groupsPut.mockReturnValueOnce(
        new Promise((resolve) => {
          landCatalogWrite = () => resolve("completed");
        }),
      );
      click(rowLink(sidebar, "agent:main:a"), { altKey: true });
      click(rowLink(sidebar, "agent:main:b"), { altKey: true });
      await sidebar.updateComplete;
      openContextMenu(sidebar, "agent:main:a");
      await sidebar.updateComplete;
      const menu = await sessionMenu(sidebar);
      menu.querySelector<HTMLElement>('wa-dropdown-item[value="new-group"]')?.click();

      await waitForInputDialog();
      await submitInputDialog("Projects");
      await waitForFast(() => expect(harness.groupsPut).toHaveBeenCalledOnce());

      // Only one of the two selected rows survives the catalog write. Moving the
      // survivor is still correct, but the other row was requested and skipped.
      harness.publish({
        result: {
          count: 1,
          sessions: [{ key: "agent:main:b", agentId: "main" }],
        } as unknown as SessionsListResult,
      });
      landCatalogWrite();

      await waitForFast(() =>
        expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull(),
      );
      // The surviving row is patched on its own; the removed key is never sent,
      // so patchMany stays out of it.
      await waitForFast(() => expect(harness.patch).toHaveBeenCalledOnce());
      expect(harness.patch).toHaveBeenCalledWith(
        "agent:main:b",
        { category: "Projects" },
        { agentId: "main" },
      );
      expect(harness.patchMany).not.toHaveBeenCalled();
      // A partly applied selection must not close as a plain success.
      expect(toastHost.querySelector(".app-toast__message")?.textContent).toBe(
        "Group created, but some selected sessions were not moved because the list changed. Move them from the row menu.",
      );
    } finally {
      toastHost.remove();
      restoreDialogPolyfill();
    }
  });
});
