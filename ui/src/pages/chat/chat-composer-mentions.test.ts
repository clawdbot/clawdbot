/* @vitest-environment jsdom */
import type { UsersMentionableResult } from "@openclaw/gateway-protocol";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  NewSessionComposerTextareaController,
  renderNewSessionComposer,
} from "../new-session/composer.ts";
import { createComposerProps, resetComposerFixture } from "./chat-composer.test-support.ts";
import { renderChatComposer } from "./components/chat-composer.ts";

const people: UsersMentionableResult = {
  users: [
    { profileId: "profile-alex-online", displayName: "Alex", online: true },
    { profileId: "profile-alex-offline", displayName: "Alex", online: false },
  ],
  truncated: false,
};
const controllers: NewSessionComposerTextareaController[] = [];

afterEach(async () => {
  controllers.splice(0).forEach((controller) => controller.disconnect());
  await resetComposerFixture();
});

function composerFixture(
  kind: "chat" | "new-session",
  initial = "",
  initialMentions: readonly HumanMention[] = [],
) {
  vi.useFakeTimers();
  const container = document.createElement("div");
  document.body.append(container);
  const client = new GatewayBrowserClient({ url: "ws://gateway.test" });
  const request = vi.spyOn(client, "request").mockResolvedValue(people);
  const eventListeners = new Set<Parameters<GatewayBrowserClient["addEventListener"]>[0]>();
  vi.spyOn(client, "addEventListener").mockImplementation((listener) => {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  });
  const controller = new NewSessionComposerTextareaController();
  controllers.push(controller);
  let draft = initial;
  let mentions = initialMentions;
  let ownerKey = "sender-one";
  let unsupported = false;
  const send = vi.fn();
  const abort = vi.fn();
  const slashCommand = vi.fn();
  const onInput = (next: string, selected?: readonly HumanMention[]) => {
    mentions = selected ?? updateHumanMentions(draft, next, mentions);
    draft = next;
  };
  const props = createComposerProps();
  const renderCurrent = () => {
    const directory = {
      client,
      ownerKey,
      params: kind === "chat" ? { sessionKey: "agent:main:chat" } : { agentId: "main" },
    };
    render(
      kind === "chat"
        ? renderChatComposer({
            ...props,
            draft,
            mentions,
            getDraft: () => draft,
            getMentions: () => mentions,
            mentionDirectory: unsupported ? undefined : directory,
            mentionsUnsupported: unsupported,
            onDraftChange: onInput,
            onRequestUpdate: renderCurrent,
            onSlashCommand: slashCommand,
            canAbort: true,
            onAbort: abort,
            onSend: () => send({ draft, mentions }),
          })
        : renderNewSessionComposer({
            message: draft,
            mentions,
            getMentions: () => mentions,
            mentionDirectory: directory,
            attachments: [],
            getAttachments: () => [],
            canSubmit: true,
            pendingAttachmentReads: 0,
            readSignal: new AbortController().signal,
            requiresModifier: false,
            requestUpdate: renderCurrent,
            submitting: false,
            textareaController: controller,
            onAttachmentsChange: () => undefined,
            onPendingReadsChange: () => undefined,
            onInput: (next, selected) => {
              onInput(next, selected);
              renderCurrent();
            },
            onSubmit: () => send({ draft, mentions }),
          }),
      container,
    );
  };
  renderCurrent();
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const edit = (
    next: string,
    options: { start?: number; end?: number; inputType?: string; data?: string | null } = {},
  ) => {
    const inputType = options.inputType ?? "insertText";
    textarea.setSelectionRange(
      options.start ?? textarea.value.length,
      options.end ?? options.start ?? textarea.value.length,
    );
    textarea.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType, data: options.data ?? next }),
    );
    textarea.value = next;
    textarea.setSelectionRange(next.length, next.length);
    textarea.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType, data: options.data ?? next }),
    );
    renderCurrent();
  };
  const pressKey = (key: string, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...extra });
    textarea.dispatchEvent(event);
    renderCurrent();
    return event;
  };
  return {
    container,
    request,
    edit,
    key: pressKey,
    send,
    abort,
    slashCommand,
    value: () => ({ draft, mentions }),
    emitEvent: (event: "presence" | "sessions.changed") => {
      for (const listener of eventListeners) {
        listener({ type: "event", event, payload: { sessionKey: "agent:main:unrelated" } });
      }
    },
    replaceOwner: () => {
      ownerKey = "sender-two";
      renderCurrent();
    },
    setUnsupported: () => {
      unsupported = true;
      renderCurrent();
    },
  };
}

describe("chat inline commands with human mentions", () => {
  it("runs an appended multi-word dashboard request and keeps the draft recipient", () => {
    const mention = { profileId: "profile-alex-online", start: 7, end: 12 };
    const view = composerFixture("chat", "Review @Alex", [mention]);

    view.edit("Review @Alex /dashboard release health");
    view.key("Enter");

    expect(view.slashCommand).toHaveBeenCalledExactlyOnceWith("/dashboard release health");
    expect(view.send).not.toHaveBeenCalled();
    expect(view.value()).toEqual({
      draft: "Review @Alex ",
      mentions: [mention],
    });
  });
});

describe.each(["chat", "new-session"] as const)("%s human mentions", (kind) => {
  it("keeps the current typed query selectable during ordinary Gateway event traffic", async () => {
    const view = composerFixture(kind);
    let resolve!: (result: UsersMentionableResult) => void;
    view.request.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    view.edit("@", { data: "@" });
    await vi.advanceTimersByTimeAsync(50);
    view.emitEvent("sessions.changed");
    view.edit("@A", { data: "A" });
    await vi.advanceTimersByTimeAsync(50);
    view.emitEvent("presence");
    view.edit("@Al", { data: "l" });
    await vi.advanceTimersByTimeAsync(150);
    expect(view.request).toHaveBeenCalledExactlyOnceWith("users.mentionable", {
      ...(kind === "chat" ? { sessionKey: "agent:main:chat" } : { agentId: "main" }),
      query: "Al",
    });
    view.emitEvent("sessions.changed");
    resolve(people);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(2);
    view.emitEvent("presence");
    expect(view.key("Enter").defaultPrevented).toBe(true);
    expect(view.send).not.toHaveBeenCalled();
    expect(view.value()).toEqual({
      draft: "@Alex ",
      mentions: [{ profileId: "profile-alex-online", start: 0, end: 5 }],
    });
  });

  it("selects an offline same-name profile before Enter can send", async () => {
    const view = composerFixture(kind);
    view.edit("@Al", { data: "@Al" });
    await vi.advanceTimersByTimeAsync(150);
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(view.container.textContent).toContain("Offline");
    view.key("ArrowDown");
    expect(view.key("Enter").defaultPrevented).toBe(true);
    expect(view.send).not.toHaveBeenCalled();
    expect(view.value()).toEqual({
      draft: "@Alex ",
      mentions: [{ profileId: "profile-alex-offline", start: 0, end: 5 }],
    });
    expect(view.container.textContent).toContain("Will notify: @Alex");
    view.key("Enter");
    expect(view.send).toHaveBeenCalledWith(view.value());
  });

  it("keeps the remaining same-name recipient after deleting the first token", () => {
    const view = composerFixture(kind, "@Alex @Alex", [
      { profileId: "first-alex", start: 0, end: 5 },
      { profileId: "second-alex", start: 6, end: 11 },
    ]);
    view.edit("@Alex", { start: 0, end: 6, inputType: "deleteContentBackward", data: null });
    view.key("Enter");
    expect(view.send).toHaveBeenCalledWith({
      draft: "@Alex",
      mentions: [{ profileId: "second-alex", start: 0, end: 5 }],
    });
  });

  it("invalidates edited tokens and never rebinds pasted names", () => {
    const view = composerFixture(kind, "@Alex", [{ profileId: "alex", start: 0, end: 5 }]);
    view.edit("@Alx", { start: 3, end: 4, inputType: "deleteContentForward", data: null });
    expect(view.value().mentions).toEqual([]);
    expect(view.container.textContent).not.toContain("Will notify:");
    view.edit("@Alex", { start: 0, end: 4, inputType: "insertFromPaste" });
    view.key("Enter");
    expect(view.send).toHaveBeenCalledWith({ draft: "@Alex", mentions: [] });
    expect(view.request).not.toHaveBeenCalled();
  });

  it.each(["email@Alex", "`@Alex", "> @Alex", "```\n@Alex"])(
    "keeps %j as plain text",
    async (text) => {
      const view = composerFixture(kind);
      view.edit(text);
      await vi.advanceTimersByTimeAsync(150);
      expect(view.request).not.toHaveBeenCalled();
      expect(view.value().mentions).toEqual([]);
    },
  );

  it("lets Escape close the picker without aborting and ignores composition Enter", async () => {
    const view = composerFixture(kind);
    view.edit("@");
    await vi.advanceTimersByTimeAsync(150);
    view.key("Enter", { isComposing: true });
    expect(view.value().mentions).toEqual([]);
    view.key("Escape");
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
    expect(view.send).not.toHaveBeenCalled();
    expect(view.abort).not.toHaveBeenCalled();
  });

  it("discards suggestions resolved after the draft owner changes", async () => {
    const view = composerFixture(kind);
    let resolve!: (result: UsersMentionableResult) => void;
    view.request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    view.edit("@");
    await vi.advanceTimersByTimeAsync(150);
    view.replaceOwner();
    resolve(people);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
  });
});

it("blocks unsupported sends until the operator explicitly removes selected mentions", () => {
  const view = composerFixture("chat", "@Alex", [{ profileId: "alex", start: 0, end: 5 }]);
  view.setUnsupported();
  view.key("Enter");
  expect(view.send).not.toHaveBeenCalled();
  expect(view.container.textContent).toContain("Human mentions are not available in this mode");
  view.container.querySelector<HTMLButtonElement>('button[aria-label="Remove mention"]')?.click();
  view.key("Enter");
  expect(view.send).toHaveBeenCalledWith({ draft: "@Alex", mentions: [] });
});
