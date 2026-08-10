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
      click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
      click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
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
      // Each target carries the identity captured with its row, so a session
      // replaced while the dialog was open is refused rather than reassigned.
      expect(harness.patchMany).toHaveBeenCalledWith(
        [
          {
            key: "agent:main:a",
            agentId: "main",
            expectedSessionId: "session-agent:main:a",
          },
          {
            key: "agent:main:b",
            agentId: "main",
            expectedSessionId: "session-agent:main:b",
          },
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

  it("assigns with captured identities when rows leave the projection mid-write", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
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
      click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
      click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
      await sidebar.updateComplete;
      openContextMenu(sidebar, "agent:main:a");
      await sidebar.updateComplete;
      const menu = await sessionMenu(sidebar);
      menu.querySelector<HTMLElement>('wa-dropdown-item[value="new-group"]')?.click();

      await waitForInputDialog();
      await submitInputDialog("Projects");
      await waitForFast(() => expect(harness.groupsPut).toHaveBeenCalledOnce());

      // Both rows leave this bounded projection while the catalog write is still
      // in flight. That is not evidence they were deleted, so the assignment must
      // still go out — carrying the identity captured with each row, which is what
      // lets the Gateway refuse a target that really was replaced.
      harness.publish({ result: { count: 0, sessions: [] } as unknown as SessionsListResult });
      landCatalogWrite();

      await waitForFast(() => expect(harness.patchMany).toHaveBeenCalledOnce());
      expect(harness.patchMany).toHaveBeenCalledWith(
        [
          {
            key: "agent:main:a",
            agentId: "main",
            expectedSessionId: "session-agent:main:a",
          },
          {
            key: "agent:main:b",
            agentId: "main",
            expectedSessionId: "session-agent:main:b",
          },
        ],
        { category: "Projects" },
      );
      expect(harness.patch).not.toHaveBeenCalled();
    } finally {
      restoreDialogPolyfill();
    }
  });
});
