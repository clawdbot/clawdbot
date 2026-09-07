import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../styles.css";
import "../../styles/settings.css";
import "../../styles/agents.css";
import "../../styles/sidebar-markdown.css";
import { finishElementAnimations } from "../../test-helpers/animations.ts";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import { renderAgentFiles } from "./panels-status-files.ts";

const browserMode = "__vitest_browser__" in globalThis;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  container.className = "settings-page";
  document.body.append(container);
});

afterEach(() => {
  render(nothing, container);
  container.remove();
});

function afterOwnTransition(
  dialog: HTMLElement,
  type: "wa-after-show" | "wa-after-hide",
): Promise<void> {
  return new Promise((resolve) => {
    const completed = (event: Event) => {
      if (event.target !== dialog) {
        return;
      }
      dialog.removeEventListener(type, completed);
      // The real dialog and adapter queue return focus before this observer's task.
      setTimeout(resolve, 0);
    };
    dialog.addEventListener(type, completed);
  });
}

async function finishTransition(dialog: Element, transition: Promise<void>): Promise<void> {
  let completed = false;
  void transition.then(() => {
    completed = true;
  });
  // Web Awesome starts its animation after a frame; an early animation snapshot can miss it.
  await expect
    .poll(() => {
      finishElementAnimations(dialog);
      return completed;
    })
    .toBe(true);
}

function requireButton(selector: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(selector);
  if (!button) {
    throw new Error(`Missing file-preview button: ${selector}`);
  }
  return button;
}

describe.runIf(browserMode)("agent file preview focus", () => {
  it.each(["edit", "close"] as const)(
    "returns focus to the intended owner after %s and retained reopen",
    async (action) => {
      const { userEvent } = await import("vitest/browser");
      const changes: string[] = [];
      let expectedDraft = "Unsaved file preview draft";
      render(
        renderAgentFiles({
          agentId: "main",
          agentFilesList: {
            agentId: "main",
            workspace: "/synthetic/workspace",
            files: [{ name: "AGENTS.md", path: "/synthetic/workspace/AGENTS.md", missing: false }],
          },
          agentFilesLoading: false,
          agentFilesError: null,
          agentFileActive: "AGENTS.md",
          agentFileContents: { "AGENTS.md": "Saved instructions" },
          agentFileDrafts: { "AGENTS.md": expectedDraft },
          agentFileSaving: false,
          canWrite: true,
          onLoadFiles: () => undefined,
          onSelectFile: () => undefined,
          onFileDraftChange: (_name, content) => changes.push(content),
          onFileReset: () => undefined,
          onFileSave: () => undefined,
        }),
        container,
      );
      const textarea = container.querySelector<HTMLTextAreaElement>(".agent-file-textarea");
      if (!textarea) {
        throw new Error("Missing agent file editor");
      }
      const preview = requireButton(".agent-file-actions button");
      const { modal, webAwesomeDialog, dialog } = await getRenderedModalDialog(container);
      expect(dialog.open).toBe(false);
      expect(textarea.value).toBe(expectedDraft);

      for (let opening = 0; opening < 2; opening += 1) {
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        const shown = afterOwnTransition(webAwesomeDialog, "wa-after-show");
        preview.focus();
        await userEvent.keyboard("{Enter}");
        await getRenderedModalDialog(container);
        await expect.poll(() => dialog.open).toBe(true);
        await finishTransition(dialog, shown);
        const closed = afterOwnTransition(webAwesomeDialog, "wa-after-hide");
        await userEvent.click(
          requireButton(
            action === "edit" ? '[aria-label="Edit file"]' : '[aria-label="Close preview"]',
          ),
        );
        await finishTransition(dialog, closed);
        expect(dialog.open).toBe(false);
        expect(modal.isConnected).toBe(true);

        if (action === "edit") {
          // Keyboard input must follow the returned focus; filling the locator would hide the bug.
          await userEvent.keyboard("-continued");
          expectedDraft += "-continued";
          expect(textarea.value).toBe(expectedDraft);
          expect(changes.at(-1)).toBe(expectedDraft);
          expect(document.activeElement).toBe(textarea);
        } else {
          expect(document.activeElement).toBe(preview);
          expect(textarea.value).toBe(expectedDraft);
          expect(changes).toEqual([]);
        }
      }
    },
  );
});
