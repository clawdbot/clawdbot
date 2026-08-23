/* @vitest-environment jsdom */

import { html, nothing, render, type LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalRequest } from "../app/exec-approval.ts";
import { i18n } from "../i18n/index.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import "./exec-approval.ts";

let container: HTMLDivElement;
let restoreDialogPolyfill: () => void;

function createExecRequest(overrides: Partial<ExecApprovalRequest> = {}): ExecApprovalRequest {
  return {
    id: "approval-1",
    kind: "exec",
    request: {
      command: "echo hello",
      ask: "on-request",
    },
    createdAtMs: Date.now() - 1_000,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

async function renderApproval(
  requestOrQueue: ExecApprovalRequest | ExecApprovalRequest[],
  overrides: Partial<{
    busy: boolean;
    canGrant: boolean;
    errors: ReadonlyMap<string, string>;
    onDecision: ReturnType<typeof vi.fn>;
  }> = {},
) {
  const queue = Array.isArray(requestOrQueue) ? requestOrQueue : [requestOrQueue];
  const onDecision = overrides.onDecision ?? vi.fn();
  render(
    html`<openclaw-exec-approval
      .props=${{
        queue,
        busy: overrides.busy ?? false,
        canGrant: overrides.canGrant ?? true,
        errors: overrides.errors ?? new Map(),
        onDecision,
      }}
    ></openclaw-exec-approval>`,
    container,
  );
  const approval = container.querySelector<LitElement>("openclaw-exec-approval");
  if (!approval) {
    throw new Error("Expected exec approval");
  }
  await approval.updateComplete;
  return { approval, onDecision };
}

async function renderOpenedApproval(
  requestOrQueue: ExecApprovalRequest | ExecApprovalRequest[],
  overrides: Parameters<typeof renderApproval>[1] = {},
) {
  const rendered = await renderApproval(requestOrQueue, overrides);
  (rendered.approval as LitElement & { show(): void }).show();
  await rendered.approval.updateComplete;
  return rendered;
}

function chord(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, ...init });
}

describe("openclaw-exec-approval", () => {
  beforeEach(async () => {
    restoreDialogPolyfill = installDialogPolyfill();
    await i18n.setLocale("en");
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    render(nothing, container);
    container.remove();
    await i18n.setLocale("en");
    restoreDialogPolyfill();
    vi.restoreAllMocks();
  });

  it("does not render a modal when an approval arrives", async () => {
    await renderApproval(createExecRequest());

    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("uses neutral unavailable copy for exec allow-always decisions", async () => {
    await renderOpenedApproval(
      createExecRequest({
        request: {
          command: "echo hello",
          ask: "always",
          allowedDecisions: ["allow-once", "deny"],
        },
      }),
    );

    await getRenderedModalDialog(container);

    expect(
      Array.from(container.querySelectorAll(".exec-approval-actions button > span")).map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(["Allow once", "Deny"]);
    expect(container.querySelector(".exec-approval-warning")?.textContent?.trim()).toBe(
      "Allow Always is unavailable for this command.",
    );
  });

  it("exposes labelled, focusable decision buttons", async () => {
    await renderOpenedApproval(createExecRequest());
    await getRenderedModalDialog(container);

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".exec-approval-actions button"),
    );
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Allow once",
      "Always allow",
      "Deny",
    ]);
    expect(buttons.every((button) => button.tabIndex === 0)).toBe(true);
  });

  it("does not show exec unavailable copy for restricted plugin approvals", async () => {
    await renderOpenedApproval(
      createExecRequest({
        id: "plugin-approval-1",
        kind: "plugin",
        request: {
          command: "Plugin approval",
          allowedDecisions: ["allow-once", "deny"],
        },
        pluginTitle: "Plugin approval",
      }),
    );

    await getRenderedModalDialog(container);

    expect(
      Array.from(container.querySelectorAll(".exec-approval-actions button > span")).map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(["Allow once", "Deny"]);
    expect(container.querySelector(".exec-approval-warning")).toBeNull();
  });

  it("keeps the visible and accessible expiry countdowns synchronized", async () => {
    let nowMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const { approval } = await renderOpenedApproval(createExecRequest({ expiresAtMs: 90_500 }));
    const { dialog } = await getRenderedModalDialog(container);
    const countdown = container.querySelector<LitElement>(".exec-approval-countdown");
    if (!countdown) {
      throw new Error("Expected approval countdown");
    }
    await countdown.updateComplete;

    expect(countdown.textContent?.trim()).toBe("expires in 01:31");
    expect(dialog.getAttribute("aria-description")).toBe("expires in 01:31");

    const renderSpy = vi.spyOn(approval as LitElement & { render(): unknown }, "render");
    nowMs = 1_000;
    await vi.waitFor(
      () => {
        expect(countdown.textContent?.trim()).toBe("expires in 01:30");
      },
      { timeout: 2_000 },
    );
    await getRenderedModalDialog(container);

    expect(dialog.getAttribute("aria-description")).toBe("expires in 01:30");
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("selects another queued request without changing queue order", async () => {
    const queue = [
      createExecRequest({ id: "approval-oldest", createdAtMs: 1 }),
      createExecRequest({
        id: "approval-newer",
        createdAtMs: 2,
        request: { command: "pnpm test", agentId: "worker" },
      }),
    ];
    const { approval } = await renderOpenedApproval(queue);
    await getRenderedModalDialog(container);

    expect(container.querySelector(".exec-approval-card")?.getAttribute("data-approval-id")).toBe(
      "approval-oldest",
    );
    container.querySelector<HTMLButtonElement>(".exec-approval-list__item")?.click();
    await approval.updateComplete;

    expect(container.querySelector(".exec-approval-card")?.getAttribute("data-approval-id")).toBe(
      "approval-newer",
    );
    expect(queue.map((entry) => entry.id)).toEqual(["approval-oldest", "approval-newer"]);
  });

  it("compacts queued commands without splitting a surrogate pair", async () => {
    const queue = [
      createExecRequest({ id: "approval-active", createdAtMs: 1 }),
      createExecRequest({
        id: "approval-queued",
        createdAtMs: 2,
        // The emoji straddles code unit 61, so a hard slice(0, 61) would
        // leave a dangling high surrogate in front of the ellipsis.
        request: { command: `${"a".repeat(60)}🙂 --with-extra-arguments` },
      }),
    ];
    await renderOpenedApproval(queue);
    await getRenderedModalDialog(container);

    expect(container.querySelector(".exec-approval-list__command")?.textContent).toBe(
      `${"a".repeat(60)}…`,
    );
  });

  it("handles modal approval keyboard shortcuts", async () => {
    const { onDecision } = await renderOpenedApproval(createExecRequest());
    const { modal } = await getRenderedModalDialog(container);

    modal.dispatchEvent(chord("Enter"));
    modal.dispatchEvent(chord("Enter", { shiftKey: true }));
    modal.dispatchEvent(chord("в", { code: "KeyD", metaKey: false, ctrlKey: true }));

    expect(onDecision.mock.calls).toEqual([
      ["approval-1", "allow-once"],
      ["approval-1", "allow-always"],
      ["approval-1", "deny"],
    ]);
  });

  it("keeps review-only decisions disabled and ignores their shortcuts", async () => {
    const { onDecision } = await renderOpenedApproval(createExecRequest(), { canGrant: false });
    const { modal } = await getRenderedModalDialog(container);
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".exec-approval-actions button"),
    );

    expect(container.querySelector(".exec-approval-warning")?.textContent?.trim()).toBe(
      "Review only. Sign in with approval access to record a decision.",
    );
    expect(buttons.every((button) => button.disabled)).toBe(true);

    buttons[0]?.click();
    modal.dispatchEvent(chord("Enter"));
    modal.dispatchEvent(chord("d"));

    expect(onDecision).not.toHaveBeenCalled();
  });

  it("ignores bare keys so stray typing cannot authorize a command", async () => {
    const { onDecision } = await renderOpenedApproval(createExecRequest());
    const { modal } = await getRenderedModalDialog(container);

    modal.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    modal.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    modal.dispatchEvent(chord("Enter", { altKey: true }));

    expect(onDecision).not.toHaveBeenCalled();
  });

  it("ignores auto-repeated shortcut keydown events", async () => {
    const { onDecision } = await renderOpenedApproval(createExecRequest());
    const { modal } = await getRenderedModalDialog(container);

    modal.dispatchEvent(chord("Enter", { repeat: true }));
    modal.dispatchEvent(chord("Enter", { shiftKey: true, repeat: true }));

    expect(onDecision).not.toHaveBeenCalled();
  });

  it("keeps the displayed approval pinned when an older request arrives", async () => {
    const newer = createExecRequest({ id: "approval-newer", createdAtMs: 2_000 });
    const older = createExecRequest({ id: "approval-older", createdAtMs: 1_000 });
    const { approval } = await renderOpenedApproval([newer]);
    await getRenderedModalDialog(container);
    expect(container.querySelector(".exec-approval-card")?.getAttribute("data-approval-id")).toBe(
      "approval-newer",
    );

    // Oldest-first sorting puts the late arrival at the head, but the card
    // the user is reading must not swap out from under them.
    await renderApproval([older, newer]);
    await approval.updateComplete;
    expect(container.querySelector(".exec-approval-card")?.getAttribute("data-approval-id")).toBe(
      "approval-newer",
    );

    // Once the pinned request settles, the head takes over.
    await renderApproval([older]);
    await approval.updateComplete;
    expect(container.querySelector(".exec-approval-card")?.getAttribute("data-approval-id")).toBe(
      "approval-older",
    );
  });

  it("guards shortcuts while busy, disallowed, or focused in text input", async () => {
    const restricted = createExecRequest({
      request: { command: "echo hello", allowedDecisions: ["allow-once", "deny"] },
    });
    const onDecision = vi.fn();
    await renderOpenedApproval(restricted, { busy: true, onDecision });
    let rendered = await getRenderedModalDialog(container);
    rendered.modal.dispatchEvent(chord("Enter"));

    await renderApproval(restricted, { onDecision });
    rendered = await getRenderedModalDialog(container);
    rendered.modal.dispatchEvent(chord("Enter", { shiftKey: true }));
    const input = document.createElement("input");
    rendered.modal.append(input);
    input.dispatchEvent(chord("d", { composed: true }));
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const editorChild = document.createElement("span");
    editor.append(editorChild);
    rendered.modal.append(editor);
    editorChild.dispatchEvent(chord("Enter", { composed: true }));

    expect(onDecision).not.toHaveBeenCalled();
  });

  it("blocks dismissal while a decision is in flight", async () => {
    const { onDecision } = await renderOpenedApproval(
      createExecRequest({ request: { command: "echo hello" } }),
      { busy: true },
    );
    const { modal } = await getRenderedModalDialog(container);
    const cancel = new CustomEvent("modal-cancel", {
      bubbles: true,
      composed: true,
      cancelable: true,
    });

    expect(modal.dispatchEvent(cancel)).toBe(false);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("dismissal closes the view without deciding and the chip can reopen it", async () => {
    const { approval, onDecision } = await renderOpenedApproval(
      createExecRequest({ request: { command: "echo hello" } }),
    );
    const { modal } = await getRenderedModalDialog(container);
    const cancel = new CustomEvent("modal-cancel", {
      bubbles: true,
      composed: true,
      cancelable: true,
    });

    expect(modal.dispatchEvent(cancel)).toBe(true);
    await approval.updateComplete;
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(onDecision).not.toHaveBeenCalled();

    (approval as LitElement & { show(): void }).show();
    await approval.updateComplete;
    expect(container.querySelector("openclaw-modal-dialog")).not.toBeNull();
  });

  // Settings Escape guards read this fact; a pending queue alone must not
  // report an open dialog now that approvals surface passively.
  it("records dialogOpen only while the dialog is explicitly open", async () => {
    const { approval } = await renderApproval(createExecRequest());
    const element = approval as LitElement & { show(): void; dialogOpen: boolean };
    expect(element.dialogOpen).toBe(false);

    element.show();
    await approval.updateComplete;
    expect(element.dialogOpen).toBe(true);

    const { modal } = await getRenderedModalDialog(container);
    modal.dispatchEvent(
      new CustomEvent("modal-cancel", { bubbles: true, composed: true, cancelable: true }),
    );
    await approval.updateComplete;
    expect(element.dialogOpen).toBe(false);
  });

  it("opens the full queue only on demand", async () => {
    const queue = [
      createExecRequest({ id: "approval-inline" }),
      createExecRequest({ id: "approval-other", request: { command: "pnpm test" } }),
    ];
    const { approval } = await renderApproval(queue);
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();

    (approval as LitElement & { show(): void }).show();
    await approval.updateComplete;

    expect(container.querySelector("openclaw-modal-dialog")).not.toBeNull();
    expect(container.querySelector(".exec-approval-card")?.getAttribute("data-approval-id")).toBe(
      "approval-inline",
    );
    expect(container.querySelectorAll(".exec-approval-list__item")).toHaveLength(1);
    expect(container.querySelector(".exec-approval-queue")?.textContent?.trim()).toBe("2 pending");
  });

  it("closes and resets after the approval queue drains", async () => {
    await renderOpenedApproval(createExecRequest());
    expect(container.querySelector("openclaw-modal-dialog")).not.toBeNull();

    let rendered = await renderApproval([]);
    await rendered.approval.updateComplete;
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();

    rendered = await renderApproval(createExecRequest());
    await rendered.approval.updateComplete;

    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
  });
});
