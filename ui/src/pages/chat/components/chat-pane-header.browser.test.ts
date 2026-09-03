import type WaTooltip from "@awesome.me/webawesome/dist/components/tooltip/tooltip.js";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTitleTooltips } from "../../../components/tooltip-title.ts";
import { i18n } from "../../../i18n/index.ts";
import "../../../styles.css";
import "../../../styles/chat/split-view.css";
import { mountChatPaneHeader } from "./chat-pane-header.test-support.ts";
import { renderChatSidebarEditorMenu } from "./chat-sidebar-editor-menu.ts";

describe.skipIf(typeof HTMLElement.prototype.checkVisibility !== "function")(
  "chat pane branch tooltip positioning",
  () => {
    const containers: HTMLElement[] = [];
    let dispose: () => void;
    let page: (typeof import("vitest/browser"))["page"];

    beforeEach(async () => {
      ({ page } = await import("vitest/browser"));
      await page.viewport(1200, 800);
      await i18n.setLocale("en");
      dispose = installTitleTooltips(document);
    });

    afterEach(() => {
      dispose();
      containers.splice(0).forEach((container) => container.remove());
    });

    it.each(["idle", "busy", "editor"] as const)(
      "anchors the %s hint to its menu button",
      async (state) => {
        const busy = state === "busy";
        const editor = state === "editor";
        const onOpenEditor = vi.fn();
        const reason = "Branch switch is unavailable while the agent is working.";
        const { container, props } = mountChatPaneHeader(containers, {
          branchSwitchDisabledReason: busy ? reason : null,
          branches: [
            { leafEntryId: "active", headline: "Current work", messageCount: 4, active: true },
            { leafEntryId: "other", headline: "Earlier idea", messageCount: 2, active: false },
          ],
        });
        if (editor) {
          render(
            renderChatSidebarEditorMenu({
              absolutePath: "/repo/example.ts",
              open: false,
              onOpenChange: () => undefined,
              onOpenEditor,
            }),
            container,
          );
        }
        container.style.cssText = "position: fixed; top: 80px; left: 500px; width: 650px";
        const trigger = container.querySelector<HTMLButtonElement>(
          editor ? ".sidebar-file-view__action" : ".chat-pane__branches-trigger",
        )!;
        await page.elementLocator(trigger).hover();
        const tooltip = () =>
          [...document.querySelectorAll("openclaw-tooltip")]
            .map((element) => element.shadowRoot?.querySelector<WaTooltip>("wa-tooltip"))
            .find((element) => element?.open);
        await expect
          .poll(() => tooltip()?.textContent)
          .toContain(editor ? "Open in editor" : busy ? reason : "Session branches");
        await expect
          .poll(() => {
            const body = tooltip()?.shadowRoot?.querySelector<HTMLElement>('[part="body"]');
            if (!body) {
              return false;
            }
            const hint = body.getBoundingClientRect();
            const button = trigger.getBoundingClientRect();
            return (
              hint.width > 0 &&
              hint.left < button.right &&
              hint.right > button.left &&
              Math.min(Math.abs(hint.bottom - button.top), Math.abs(hint.top - button.bottom)) < 24
            );
          })
          .toBe(true);

        if (!busy) {
          await page.elementLocator(trigger).click();
          await expect.poll(() => tooltip()).toBeUndefined();
          await page.getByRole("menuitem", { name: editor ? "VS Code" : /Earlier idea/ }).click();
          expect(editor ? onOpenEditor : props.onBranchSelect).toHaveBeenCalledWith(
            editor ? "vscode" : "other",
          );
        }
      },
    );
  },
);
