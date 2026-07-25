/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import { renderNewSessionDraftComposer } from "./composer.ts";
import { NewSessionModelControl } from "./model-control.ts";

const attachmentDrafts: NewSessionAttachmentDraft[] = [];

function renderComposer(
  overrides: {
    submitting?: boolean;
    messageLocked?: boolean;
    incognito?: boolean;
    onToggleIncognito?: () => void;
  } = {},
) {
  const container = document.createElement("div");
  const attachmentDraft = new NewSessionAttachmentDraft(() => undefined);
  attachmentDrafts.push(attachmentDraft);
  render(
    renderNewSessionDraftComposer({
      agentId: "main",
      attachmentDraft,
      canSubmit: true,
      context: undefined,
      isCatalogTarget: true,
      message: "",
      incognito: overrides.incognito,
      modelControl: new NewSessionModelControl(() => undefined),
      requiresModifier: false,
      submitting: overrides.submitting ?? false,
      messageLocked: overrides.messageLocked,
      onInput: () => undefined,
      onToggleIncognito: overrides.onToggleIncognito,
      onSubmit: () => undefined,
    }),
    container,
  );
  const composer = container.querySelector<HTMLElement>(".new-session-page__composer");
  if (!composer) {
    throw new Error("Expected new-session composer");
  }
  return { attachmentDraft, composer };
}

function createDragEvent(type: string, files: File[] = [], types = ["Files"]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, types },
  });
  return event;
}

afterEach(() => {
  for (const attachmentDraft of attachmentDrafts) {
    attachmentDraft.reset({ release: true });
  }
  attachmentDrafts.length = 0;
  vi.restoreAllMocks();
});

describe("new-session composer attachment drops", () => {
  it("renders the incognito switch off by default and forwards toggles", () => {
    const onToggleIncognito = vi.fn();
    const { composer } = renderComposer({ onToggleIncognito });
    const toggle = composer.querySelector<HTMLButtonElement>('[role="switch"]');

    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    toggle?.click();
    expect(onToggleIncognito).toHaveBeenCalledOnce();
  });

  it("renders a distinct active state when incognito is selected", () => {
    const { composer } = renderComposer({ incognito: true });
    const toggle = composer.querySelector<HTMLButtonElement>('[role="switch"]');

    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(toggle?.classList.contains("new-session-page__incognito--active")).toBe(true);
  });

  it("adds a dropped file through the shared attachment handling", async () => {
    const { attachmentDraft, composer } = renderComposer();
    const replace = vi.spyOn(attachmentDraft, "replace");
    const file = new File(["image"], "pic.png", { type: "image/png" });

    composer.dispatchEvent(createDragEvent("drop", [file]));

    await waitForFast(() => expect(replace).toHaveBeenCalledOnce());
    expect(replace).toHaveBeenCalledWith([
      expect.objectContaining({
        fileName: "pic.png",
        mimeType: "image/png",
        sizeBytes: file.size,
      }),
    ]);
    expect(attachmentDraft.attachments).toHaveLength(1);
    expect(attachmentDraft.attachments[0]).toMatchObject({
      fileName: "pic.png",
      mimeType: "image/png",
      sizeBytes: file.size,
    });
  });

  it("keeps the drop affordance balanced across nested drag targets", () => {
    const { composer } = renderComposer();

    composer.dispatchEvent(createDragEvent("dragenter"));
    expect(composer.hasAttribute("data-attachment-drop-active")).toBe(true);

    composer.dispatchEvent(createDragEvent("dragenter"));
    composer.dispatchEvent(createDragEvent("dragleave"));
    expect(composer.hasAttribute("data-attachment-drop-active")).toBe(true);

    composer.dispatchEvent(createDragEvent("dragleave"));
    expect(composer.hasAttribute("data-attachment-drop-active")).toBe(false);
  });

  it("keeps non-file drops native inside the textarea and cancels them elsewhere", () => {
    const { attachmentDraft, composer } = renderComposer();
    const replace = vi.spyOn(attachmentDraft, "replace");
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }

    const dragenter = createDragEvent("dragenter", [], ["text/plain"]);
    composer.dispatchEvent(dragenter);
    expect(composer.hasAttribute("data-attachment-drop-active")).toBe(false);

    const textareaDrop = createDragEvent("drop", [], ["text/plain"]);
    textarea.dispatchEvent(textareaDrop);
    expect(textareaDrop.defaultPrevented).toBe(false);

    const shellDrop = createDragEvent("drop", [], ["text/uri-list"]);
    composer.dispatchEvent(shellDrop);
    expect(shellDrop.defaultPrevented).toBe(true);
    expect(replace).not.toHaveBeenCalled();

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    composer.append(checkbox);
    const checkboxDrop = createDragEvent("drop", [], ["text/uri-list"]);
    checkbox.dispatchEvent(checkboxDrop);
    expect(checkboxDrop.defaultPrevented).toBe(true);
  });

  it.each([
    { submitting: true, messageLocked: false },
    { submitting: false, messageLocked: true },
  ])("ignores drops while the composer is disabled", (disabled) => {
    const { attachmentDraft, composer } = renderComposer(disabled);
    const replace = vi.spyOn(attachmentDraft, "replace");
    const readAsDataUrl = vi.spyOn(FileReader.prototype, "readAsDataURL");
    const file = new File(["image"], "pic.png", { type: "image/png" });

    composer.dispatchEvent(createDragEvent("dragenter"));
    composer.dispatchEvent(createDragEvent("drop", [file]));

    expect(composer.hasAttribute("data-attachment-drop-active")).toBe(false);
    expect(readAsDataUrl).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(attachmentDraft.attachments).toEqual([]);

    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    expect(textarea.disabled).toBe(true);
    const disabledTextareaDrop = createDragEvent("drop", [], ["text/uri-list"]);
    textarea.dispatchEvent(disabledTextareaDrop);
    expect(disabledTextareaDrop.defaultPrevented).toBe(true);
  });
});
