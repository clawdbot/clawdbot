/* @vitest-environment jsdom */

import { html, render, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  buildFallbackSlashCommands,
  getSkillCommandCompletions,
  replaceSlashCommands,
} from "../../lib/chat/commands.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { adjustTextareaHeight } from "../chat/components/chat-composer-dom.ts";
import { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import { NewSessionComposerTextareaController } from "./composer.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import { renderNewSessionDraftComposer } from "./draft-composer.ts";
import { NewSessionModelControl } from "./model-control.ts";

const attachmentDrafts: NewSessionAttachmentDraft[] = [];
const textareaControllers: NewSessionComposerTextareaController[] = [];

function renderComposer(
  overrides: {
    canSubmit?: boolean;
    requiresModifier?: boolean;
    submitDisabledReason?: string;
    blockedSubmitNotice?: string;
    dictationActive?: boolean;
    dictationPreview?: string;
    dictationStatus?: TemplateResult;
    terminalAction?: {
      canStart: boolean;
      disabledReason?: string;
      onStart: () => void;
    };
    submitting?: boolean;
    messageLocked?: boolean;
    visibility?: NewSessionVisibility;
    draftAvailable?: boolean;
    toolOverrides?: SessionToolOverrides | null;
    onVisibilityChange?: (visibility: NewSessionVisibility) => void;
    message?: string;
    draftOwnerKey?: string;
    agentId?: string;
    context?: ApplicationContext;
    onInput?: (message: string) => void;
    onSubmit?: () => void;
    onBackgroundSubmit?: () => void;
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
  let agentId = overrides.agentId ?? "main";
  let draftOwnerKey = overrides.draftOwnerKey ?? "draft:one";
  const renderCurrent = () =>
    render(
      renderNewSessionDraftComposer({
        agentId,
        attachmentDraft,
        canSubmit: overrides.canSubmit ?? true,
        context: overrides.context,
        draftOwnerKey,
        isCatalogTarget: true,
        message,
        visibility: overrides.visibility,
        draftAvailable: overrides.draftAvailable,
        toolOverrides: overrides.toolOverrides,
        modelControl: new NewSessionModelControl(() => undefined),
        requiresModifier: overrides.requiresModifier ?? false,
        requestUpdate: renderCurrent,
        submitDisabledReason: overrides.submitDisabledReason,
        blockedSubmitNotice: overrides.blockedSubmitNotice,
        dictationActive: overrides.dictationActive,
        dictationPreview: overrides.dictationPreview,
        dictationStatus: overrides.dictationStatus,
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
        onBackgroundSubmit: overrides.onBackgroundSubmit,
      }),
      container,
    );
  renderCurrent();
  const composer = container.querySelector<HTMLElement>(".new-session-page__composer");
  if (!composer) {
    throw new Error("Expected new-session composer");
  }
  return {
    attachmentDraft,
    composer,
    container,
    textareaController,
    rerender: renderCurrent,
    rerenderForAgent: (nextAgentId: string) => {
      agentId = nextAgentId;
      renderCurrent();
    },
    rerenderForDraftRoute: (nextDraftOwnerKey: string, nextMessage: string) => {
      draftOwnerKey = nextDraftOwnerKey;
      message = nextMessage;
      renderCurrent();
    },
  };
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
  it("opens slash commands and inserts the selected command with Enter", () => {
    replaceSlashCommands([
      {
        key: "test-command",
        name: "test-command",
        description: "Test command.",
      },
      {
        key: "local-command",
        name: "local-command",
        description: "Existing-session action.",
        executeLocal: true,
      },
    ]);
    const onSubmit = vi.fn();
    let message = "";
    const { composer } = renderComposer({
      onInput: (next) => {
        message = next;
      },
      onSubmit,
    });
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }

    textarea.value = "/";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    expect(composer.querySelector("#chat-new-session-slash-menu-listbox")?.textContent).toContain(
      "/test-command",
    );
    expect(
      composer.querySelector("#chat-new-session-slash-menu-listbox")?.textContent,
    ).not.toContain("/local-command");
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    expect(message).toBe("/test-command ");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("drops a pending skill completion when the selected agent changes", async () => {
    const response = createDeferred<CommandsListResult>();
    const request = vi.fn(() => response.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const context = {
      gateway: { snapshot: { client } },
    } as unknown as ApplicationContext;
    const { composer, rerenderForAgent, textareaController } = renderComposer({
      agentId: "writer",
      context,
      message: "$",
    });
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }

    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
    expect(request).toHaveBeenCalledWith("commands.list", {
      agentId: "writer",
      includeArgs: true,
      scope: "text",
    });

    rerenderForAgent("reviewer");
    response.resolve({
      commands: [
        {
          acceptsArgs: true,
          description: "Only available to the previous agent.",
          name: "writer_only",
          scope: "both",
          source: "skill",
          skillModelVisible: true,
          textAliases: ["/writer_only"],
        },
      ],
    });
    await waitForFast(() => {
      expect(textareaController.skillMenuState.skillCommandRefreshPending).toBe(false);
    });
    expect(composer.querySelector(".skill-menu")?.textContent ?? "").not.toContain("writer_only");
    expect(getSkillCommandCompletions("writer_only")).toEqual([]);
  });

  it("drops a pending skill completion when the Gateway client changes", async () => {
    const response = createDeferred<CommandsListResult>();
    const firstRequest = vi.fn(() => response.promise);
    const firstClient = {
      request: firstRequest,
    } as unknown as GatewayBrowserClient;
    const secondClient = {
      request: vi.fn(),
    } as unknown as GatewayBrowserClient;
    const snapshot = { client: firstClient };
    const context = {
      gateway: { snapshot },
    } as unknown as ApplicationContext;
    const { composer, rerender, textareaController } = renderComposer({
      agentId: "writer",
      context,
      message: "$",
    });
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }

    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
    expect(firstRequest).toHaveBeenCalledWith("commands.list", {
      agentId: "writer",
      includeArgs: true,
      scope: "text",
    });

    snapshot.client = secondClient;
    rerender();
    response.resolve({
      commands: [
        {
          acceptsArgs: true,
          description: "Only available through the previous Gateway client.",
          name: "previous_client_only",
          scope: "both",
          source: "skill",
          skillModelVisible: true,
          textAliases: ["/previous_client_only"],
        },
      ],
    });
    await waitForFast(() => {
      expect(textareaController.skillMenuState.skillCommandRefreshPending).toBe(false);
    });
    expect(composer.querySelector(".skill-menu")?.textContent ?? "").not.toContain(
      "previous_client_only",
    );
    expect(getSkillCommandCompletions("previous_client_only")).toEqual([]);
  });

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

  it("closes a skill menu when a route change replaces the owned draft", () => {
    replaceSlashCommands([
      {
        key: "release_notes",
        name: "release_notes",
        description: "Draft release notes.",
        source: "skill",
        skillModelVisible: true,
      },
    ]);
    const onSubmit = vi.fn();
    const { composer, rerenderForDraftRoute } = renderComposer({ onSubmit });

    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    textarea.value = "$";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(composer.querySelector(".skill-menu")).not.toBeNull();

    rerenderForDraftRoute("draft:two", "replacement task");
    expect(composer.querySelector(".skill-menu")).toBeNull();

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("retargets inline slash completion when the caret moves without input", () => {
    replaceSlashCommands([
      {
        key: "release_notes",
        name: "release_notes",
        description: "Draft release notes.",
        source: "skill",
        skillModelVisible: true,
      },
      {
        key: "office_hours",
        name: "office_hours",
        description: "Engineering office hours.",
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

    textarea.value = "Use /release_ and /office_";
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(composer.querySelector(".slash-menu")?.textContent).toContain("/office_hours");

    const firstTokenCaret = "Use /release_".length;
    textarea.setSelectionRange(firstTokenCaret, firstTokenCaret);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
    expect(composer.querySelector(".slash-menu")?.textContent).toContain("/release_notes");
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );

    expect(message).toBe("Use $release_notes and /office_");
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
    const onBackgroundSubmit = vi.fn();
    const { composer } = renderComposer({
      canSubmit: true,
      onSubmit,
      onBackgroundSubmit,
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
    expect(onBackgroundSubmit).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "Ctrl+Enter in Enter mode",
      ctrlKey: true,
      metaKey: false,
      requiresModifier: false,
      shiftKey: false,
    },
    {
      label: "Meta+Enter in Enter mode",
      ctrlKey: false,
      metaKey: true,
      requiresModifier: false,
      shiftKey: false,
    },
    {
      label: "Ctrl+Shift+Enter in modifier mode",
      ctrlKey: true,
      metaKey: false,
      requiresModifier: true,
      shiftKey: true,
    },
    {
      label: "Meta+Shift+Enter in modifier mode",
      ctrlKey: false,
      metaKey: true,
      requiresModifier: true,
      shiftKey: true,
    },
  ])("starts in the background with $label", (testCase) => {
    const onSubmit = vi.fn();
    const onBackgroundSubmit = vi.fn();
    const { composer } = renderComposer({
      onSubmit,
      onBackgroundSubmit,
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
      shiftKey: testCase.shiftKey,
    });

    textarea.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onBackgroundSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
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

  it("renders a reasoned submit block as an attached notice and keeps Start explanatory", () => {
    const onSubmit = vi.fn();
    const { composer } = renderComposer({
      canSubmit: false,
      submitDisabledReason: "Restoring your last session setup…",
      blockedSubmitNotice: "Restoring your last session setup…",
      onSubmit,
    });
    const notice = composer.querySelector<HTMLElement>(".new-session-page__blocked-submit");
    const input = composer.querySelector<HTMLElement>(".agent-chat__input");
    const start = composer.querySelector<HTMLButtonElement>(".new-session-page__start-submit");

    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.classList.contains("agent-chat__composer-underlaps")).toBe(true);
    expect(notice?.getAttribute("data-tone")).toBe("info");
    expect(notice?.querySelector(".agent-chat__composer-status-band")).not.toBeNull();
    expect(notice?.textContent?.trim()).toBe("Restoring your last session setup…");
    expect(input?.contains(notice ?? null)).toBe(false);
    expect(notice?.querySelector("svg")).not.toBeNull();
    expect(start?.disabled).toBe(false);
    expect(start?.getAttribute("aria-disabled")).toBe("true");
    start?.click();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("previews dictation in a locked draft and reserves the primary slot for Send", () => {
    const onSubmit = vi.fn();
    const { composer } = renderComposer({
      message: "Existing draft",
      dictationActive: true,
      dictationPreview: "Existing draft spoken words",
      dictationStatus: html`<div class="agent-chat__dictation-status">Listening…</div>`,
      onSubmit,
    });
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea");

    expect(textarea?.value).toBe("Existing draft spoken words");
    expect(textarea?.readOnly).toBe(true);
    expect(composer.querySelector(".agent-chat__dictation-status")?.textContent).toBe("Listening…");
    expect(composer.querySelector(".new-session-page__start-submit")).toBeNull();
    textarea?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(onSubmit).not.toHaveBeenCalled();
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

  it("renders the terminal action as a direct square-terminal button on the right", () => {
    const onStart = vi.fn();
    const { composer } = renderComposer({
      terminalAction: { canStart: true, onStart },
    });
    const trigger = composer.querySelector<HTMLButtonElement>(
      ".new-session-page__start-menu-trigger",
    );

    expect(composer.querySelector(".new-session-page__start-split")).not.toBeNull();
    expect(trigger?.disabled).toBe(false);
    expect(trigger?.getAttribute("aria-label")).toBe("Start in terminal");
    expect(trigger?.querySelector("svg")).not.toBeNull();
    expect(
      trigger?.previousElementSibling?.querySelector(".new-session-page__start-submit"),
    ).not.toBeNull();
    trigger?.click();
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
    const tooltips = composer.querySelectorAll<HTMLElement>("openclaw-tooltip");

    expect(trigger?.disabled).toBe(true);
    expect((tooltips[1] as HTMLElement & { content?: string })?.content).toBe(reason);
    trigger?.click();
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
        draftOwnerKey: "draft:one",
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
        draftOwnerKey: "draft:one",
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

  it("lets one draft pill replace page-level incognito", () => {
    const onVisibilityChange = vi.fn();
    const { composer } = renderComposer({
      draftAvailable: true,
      visibility: "draft",
      onVisibilityChange,
    });
    const draftPill = composer.querySelector<HTMLButtonElement>('[role="switch"]');
    const visibleDraftButtons = Array.from(
      composer.querySelectorAll<HTMLButtonElement>(".agent-chat__composer-footer button"),
    ).filter((button) => button.textContent?.trim() === "Draft");

    expect(draftPill?.textContent).toContain("Draft");
    expect(draftPill?.getAttribute("aria-checked")).toBe("true");
    expect(visibleDraftButtons).toEqual([draftPill]);

    draftPill?.click();
    expect(onVisibilityChange).toHaveBeenCalledWith("normal");
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

describe("new-session composer dictation insertion", () => {
  function draftTextarea(composer: HTMLElement, value: string, start: number, end = start) {
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    textarea.value = value;
    textarea.selectionStart = start;
    textarea.selectionEnd = end;
    return textarea;
  }

  it("inserts at the caret the writer left, not where the caret ended up", () => {
    const { composer, textareaController } = renderComposer({ message: "ship it" });
    const textarea = draftTextarea(composer, "ship it", 4);

    // Pressing the microphone blurs the draft, so the caret is read then rather
    // than when the transcript comes back and the caret has moved.
    textareaController.captureSelection();
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;

    expect(textareaController.insertTranscript("please")).toBe("ship please it");
    expect(textarea.value).toBe("ship please it");
  });

  it("replaces the range the writer had highlighted", () => {
    const { composer, textareaController } = renderComposer({ message: "ship the thing" });
    draftTextarea(composer, "ship the thing", 5, 14);
    textareaController.captureSelection();

    expect(textareaController.insertTranscript("it now")).toBe("ship it now");
  });

  it("appends when no caret was captured", () => {
    const { composer, textareaController } = renderComposer({ message: "ship" });
    draftTextarea(composer, "ship", 0);

    expect(textareaController.insertTranscript("it")).toBe("ship it");
  });

  it("reads uncommitted keystrokes from the draft rather than the committed value", () => {
    const { composer, textareaController } = renderComposer({ message: "ship" });
    // The writer kept typing after the last commit upward; the element holds it.
    draftTextarea(composer, "ship the", 8);
    textareaController.captureSelection();

    expect(textareaController.insertTranscript("thing")).toBe("ship the thing");
  });

  it("reports nothing to insert for a blank transcript so the draft is left alone", () => {
    const { composer, textareaController } = renderComposer({ message: "ship it" });
    const textarea = draftTextarea(composer, "ship it", 7);
    textareaController.captureSelection();

    expect(textareaController.insertTranscript("   ")).toBeNull();
    expect(textarea.value).toBe("ship it");
  });

  it("spends a captured caret once, so a later transcript appends instead of reusing it", () => {
    const { composer, textareaController } = renderComposer({ message: "ship it" });
    draftTextarea(composer, "ship it", 0);
    textareaController.captureSelection();

    expect(textareaController.insertTranscript("please")).toBe("please ship it");
    expect(textareaController.insertTranscript("now")).toBe("please ship it now");
  });

  it("previews from the captured draft without consuming or mutating it", () => {
    const { composer, textareaController } = renderComposer({ message: "ship it" });
    const textarea = draftTextarea(composer, "ship it", 4);
    textareaController.captureSelection();

    expect(textareaController.previewTranscript("please")).toBe("ship please it");
    expect(textarea.value).toBe("ship it");
    expect(textareaController.insertTranscript("please")).toBe("ship please it");
  });

  it("has nothing to insert into once the draft is gone", () => {
    const { textareaController } = renderComposer({ message: "ship it" });
    textareaController.captureSelection();
    textareaController.disconnect();

    expect(textareaController.insertTranscript("it")).toBeNull();
  });
});
