/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFallbackSlashCommands, replaceSlashCommands } from "../../lib/chat/commands.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { adjustTextareaHeight } from "../chat/components/chat-composer-dom.ts";
import { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import { NewSessionComposerTextareaController, renderNewSessionDraftComposer } from "./composer.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import { NewSessionModelControl } from "./model-control.ts";

const attachmentDrafts: NewSessionAttachmentDraft[] = [];
const textareaControllers: NewSessionComposerTextareaController[] = [];

function renderComposer(
  overrides: {
    canSubmit?: boolean;
    requiresModifier?: boolean;
    submitDisabledReason?: string;
    blockedSubmitNotice?: string;
    terminalAction?: {
      canStart: boolean;
      disabledReason?: string;
      onStart: () => void;
    };
    submitting?: boolean;
    messageLocked?: boolean;
    visibility?: NewSessionVisibility;
    draftAvailable?: boolean;
    onVisibilityChange?: (visibility: NewSessionVisibility) => void;
    message?: string;
    onInput?: (message: string) => void;
    onSubmit?: () => void;
    textareaController?: NewSessionComposerTextareaController;
  } = {},
) {
  const container = document.createElement("div");
  const attachmentDraft = new NewSessionAttachmentDraft(
    () => undefined,
    () => undefined,
  );
  attachmentDrafts.push(attachmentDraft);
  const textareaController =
    overrides.textareaController ?? new NewSessionComposerTextareaController();
  if (!textareaControllers.includes(textareaController)) {
    textareaControllers.push(textareaController);
  }
  let message = overrides.message ?? "";
  const renderCurrent = () =>
    render(
      renderNewSessionDraftComposer({
        agentId: "main",
        attachmentDraft,
        canSubmit: overrides.canSubmit ?? true,
        context: undefined,
        isCatalogTarget: true,
        message,
        visibility: overrides.visibility,
        draftAvailable: overrides.draftAvailable,
        modelControl: new NewSessionModelControl(() => undefined),
        requiresModifier: overrides.requiresModifier ?? false,
        requestUpdate: renderCurrent,
        submitDisabledReason: overrides.submitDisabledReason,
        blockedSubmitNotice: overrides.blockedSubmitNotice,
        terminalAction: overrides.terminalAction,
        submitting: overrides.submitting ?? false,
        textareaController,
        messageLocked: overrides.messageLocked,
        onInput: (next) => {
          message = next;
          overrides.onInput?.(next);
          renderCurrent();
        },
        onVisibilityChange: overrides.onVisibilityChange,
        onSubmit: overrides.onSubmit ?? (() => undefined),
      }),
      container,
    );
  renderCurrent();
  const composer = container.querySelector<HTMLElement>(".new-session-page__composer");
  if (!composer) {
    throw new Error("Expected new-session composer");
  }
  return { attachmentDraft, composer, container, textareaController };
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
  for (const textareaController of textareaControllers) {
    textareaController.disconnect();
  }
  textareaControllers.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  replaceSlashCommands(buildFallbackSlashCommands());
});

describe("new-session composer keyboard submission", () => {
  it("opens skill mentions and inserts the selected skill with Enter", () => {
    replaceSlashCommands([
      {
        key: "release_notes",
        name: "release_notes",
        description: "Draft release notes.",
        source: "skill",
        skillModelVisible: true,
      },
    ]);
    let message = "";
    const { composer } = renderComposer({
      onInput: (next) => {
        message = next;
      },
    });
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }

    textarea.value = "$";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    expect(composer.querySelector(".skill-menu")?.textContent).toContain("release_notes");
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    expect(message).toBe("$release_notes ");
  });

  it.each([
    { label: "Enter", requiresModifier: false, ctrlKey: false, metaKey: false },
    { label: "Ctrl+Enter", requiresModifier: true, ctrlKey: true, metaKey: false },
    { label: "Meta+Enter", requiresModifier: true, ctrlKey: false, metaKey: true },
  ])("keeps $label native when submission is silently gated", (testCase) => {
    const onSubmit = vi.fn();
    const { composer } = renderComposer({
      canSubmit: false,
      onSubmit,
      requiresModifier: testCase.requiresModifier,
    });
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: testCase.ctrlKey,
      key: "Enter",
      metaKey: testCase.metaKey,
    });

    textarea.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    { label: "Enter", requiresModifier: false, ctrlKey: false, metaKey: false },
    { label: "Ctrl+Enter", requiresModifier: true, ctrlKey: true, metaKey: false },
    { label: "Meta+Enter", requiresModifier: true, ctrlKey: false, metaKey: true },
  ])("submits once with $label when starting a session is enabled", (testCase) => {
    const onSubmit = vi.fn();
    const { composer } = renderComposer({
      canSubmit: true,
      onSubmit,
      requiresModifier: testCase.requiresModifier,
    });
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: testCase.ctrlKey,
      key: "Enter",
      metaKey: testCase.metaKey,
    });

    textarea.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("forwards Enter to onSubmit while a reasoned gate blocks submission", () => {
    // Silent-swallow regression: an Enter press during a transient gate
    // (preference restore, reconnect) must reach the submission flow so it
    // can surface the blocking reason, not die in the keydown handler.
    const onSubmit = vi.fn();
    const { composer } = renderComposer({
      canSubmit: false,
      submitDisabledReason: "Restoring your last session setup…",
      onSubmit,
    });
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" });

    textarea.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("renders the blocked-submit notice near the composer", () => {
    const { composer } = renderComposer({
      canSubmit: false,
      blockedSubmitNotice: "Restoring your last session setup…",
    });
    const notice = composer.querySelector<HTMLElement>(".new-session-page__blocked-submit");

    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent?.trim()).toBe("Restoring your last session setup…");
  });
});

describe("new-session composer start control", () => {
  it("keeps the plain Start button unchanged when the terminal action is hidden", () => {
    const { composer } = renderComposer();

    expect(composer.querySelectorAll(".chat-send-btn")).toHaveLength(1);
    expect(composer.querySelector(".new-session-page__start-split")).toBeNull();
    expect(composer.querySelector("wa-dropdown-item[value='start-terminal']")).toBeNull();
  });

  it("marks the Start button busy while the session is starting", () => {
    const { composer } = renderComposer({ submitting: true });
    const start = composer.querySelector<HTMLButtonElement>(".new-session-page__start-submit");

    expect(start?.getAttribute("aria-busy")).toBe("true");
    expect(start?.getAttribute("aria-label")).toBe("Starting…");
  });

  it("renders the terminal action as a secondary split-button menu item", () => {
    const onStart = vi.fn();
    const { composer } = renderComposer({
      terminalAction: { canStart: true, onStart },
    });
    const trigger = composer.querySelector<HTMLButtonElement>(
      ".new-session-page__start-menu-trigger",
    );
    const item = composer.querySelector<HTMLElement>("wa-dropdown-item[value='start-terminal']");

    expect(composer.querySelector(".new-session-page__start-split")).not.toBeNull();
    expect(trigger?.disabled).toBe(false);
    expect(trigger?.getAttribute("aria-label")).toBe("Start in terminal");
    expect(item?.textContent?.trim()).toBe("Start in terminal");
    item?.click();
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("disables the terminal action with its existing tooltip reason pattern", () => {
    const onStart = vi.fn();
    const reason = "This Gateway does not support this session action.";
    const { composer } = renderComposer({
      terminalAction: { canStart: false, disabledReason: reason, onStart },
    });
    const trigger = composer.querySelector<HTMLButtonElement>(
      ".new-session-page__start-menu-trigger",
    );
    const item = composer.querySelector<HTMLElement>("wa-dropdown-item[value='start-terminal']");
    const tooltips = composer.querySelectorAll<HTMLElement>("openclaw-tooltip");

    expect(trigger?.disabled).toBe(true);
    expect(item?.hasAttribute("disabled")).toBe(true);
    expect((tooltips[1] as HTMLElement & { content?: string })?.content).toBe(reason);
    item?.click();
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("new-session composer sizing lifecycle", () => {
  it("keeps the shared fallback for non-pixel CSS caps", () => {
    const textarea = document.createElement("textarea");
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 500 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      maxHeight: "50vh",
    } as CSSStyleDeclaration);

    adjustTextareaHeight(textarea);

    expect(textarea.style.height).toBe("150px");
  });

  it("keeps one observer across controlled updates and remeasures programmatic drafts", async () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    const resizeObserverConstructed = vi.fn();
    class TestResizeObserver {
      constructor() {
        resizeObserverConstructed();
      }
      observe = observe;
      disconnect = disconnect;
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const textareaController = new NewSessionComposerTextareaController();
    const onInput = vi.fn();
    const first = renderComposer({ textareaController, onInput });
    document.body.append(first.container);
    const textarea = first.composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    let scrollHeightReads = 0;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => {
        scrollHeightReads += 1;
        return 42;
      },
    });
    await Promise.resolve();
    const readsAfterAttach = scrollHeightReads;

    textarea.value = "typed";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(onInput).toHaveBeenCalledWith("typed");
    const readsAfterInput = scrollHeightReads;
    render(
      renderNewSessionDraftComposer({
        agentId: "main",
        attachmentDraft: first.attachmentDraft,
        canSubmit: true,
        context: undefined,
        isCatalogTarget: true,
        message: "typed",
        modelControl: new NewSessionModelControl(() => undefined),
        requiresModifier: false,
        requestUpdate: () => undefined,
        submitting: false,
        textareaController,
        onInput,
        onSubmit: () => undefined,
      }),
      first.container,
    );
    await Promise.resolve();

    expect(first.container.querySelector("textarea")).toBe(textarea);
    expect(resizeObserverConstructed).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
    expect(scrollHeightReads).toBe(readsAfterInput);

    render(
      renderNewSessionDraftComposer({
        agentId: "main",
        attachmentDraft: first.attachmentDraft,
        canSubmit: true,
        context: undefined,
        isCatalogTarget: true,
        message: "restored programmatically",
        modelControl: new NewSessionModelControl(() => undefined),
        requiresModifier: false,
        requestUpdate: () => undefined,
        submitting: false,
        textareaController,
        onInput,
        onSubmit: () => undefined,
      }),
      first.container,
    );
    await Promise.resolve();

    expect(scrollHeightReads).toBeGreaterThan(readsAfterInput);
    expect(readsAfterAttach).toBeGreaterThan(0);
    expect(resizeObserverConstructed).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
    textareaController.disconnect();
    expect(disconnect).toHaveBeenCalledOnce();
    first.container.remove();
  });
});

describe("new-session composer attachment drops", () => {
  it("surfaces authorization reasons on the disabled submit control", () => {
    const { composer } = renderComposer({
      canSubmit: false,
      submitDisabledReason: "This action requires operator.write access.",
    });
    const submitTooltip = composer.querySelector<HTMLElement>("openclaw-tooltip");

    expect((submitTooltip as HTMLElement & { content?: string })?.content).toBe(
      "This action requires operator.write access.",
    );
  });

  it("places the attachment menu in the composer footer", () => {
    const { composer } = renderComposer();
    const attachmentMenu = composer.querySelector<HTMLElement>(".agent-chat__attach-menu");

    expect(attachmentMenu?.closest(".agent-chat__composer-footer")).not.toBeNull();
    expect(attachmentMenu?.closest(".agent-chat__composer-input-row")).toBeNull();
  });

  it("keeps page-level incognito out of the composer when drafts are unavailable", () => {
    const { composer } = renderComposer();
    const switches = composer.querySelectorAll<HTMLButtonElement>('[role="switch"]');

    expect(switches).toHaveLength(0);
  });

  it("lets the draft pill replace page-level incognito", () => {
    const onVisibilityChange = vi.fn();
    const { composer } = renderComposer({
      draftAvailable: true,
      visibility: "incognito",
      onVisibilityChange,
    });
    const draftPill = composer.querySelector<HTMLButtonElement>('[role="switch"]');

    expect(draftPill?.textContent).toContain("Draft");
    expect(draftPill?.getAttribute("aria-checked")).toBe("false");

    draftPill?.click();
    expect(onVisibilityChange).toHaveBeenCalledWith("draft");
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
