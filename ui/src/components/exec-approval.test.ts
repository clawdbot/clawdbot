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
    errors: ReadonlyMap<string, string>;
    nowMs: number;
    inlineApprovalId: string | null;
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
        errors: overrides.errors ?? new Map(),
        nowMs: overrides.nowMs ?? Date.now(),
        inlineApprovalId: overrides.inlineApprovalId ?? null,
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

  it("uses neutral unavailable copy for exec allow-always decisions", async () => {
    await renderApproval(
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

  it("does not show exec unavailable copy for restricted plugin approvals", async () => {
    await renderApproval(
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

  it("renders the live expiry countdown as mm:ss", async () => {
    await renderApproval(createExecRequest({ expiresAtMs: 90_500 }), { nowMs: 0 });
    await getRenderedModalDialog(container);

    expect(container.querySelector(".exec-approval-countdown")?.textContent?.trim()).toBe(
      "expires in 01:31",
    );
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
    const { approval } = await renderApproval(queue);
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

  it("handles modal approval keyboard shortcuts", async () => {
    const { onDecision } = await renderApproval(createExecRequest());
    const { modal } = await getRenderedModalDialog(container);

    modal.dispatchEvent(chord("Enter"));
    modal.dispatchEvent(chord("Enter", { shiftKey: true }));
    modal.dispatchEvent(chord("d", { metaKey: false, ctrlKey: true }));

    expect(onDecision.mock.calls).toEqual([
      ["approval-1", "allow-once"],
      ["approval-1", "allow-always"],
      ["approval-1", "deny"],
    ]);
  });

  it("ignores bare keys so stray typing cannot authorize a command", async () => {
    const { onDecision } = await renderApproval(createExecRequest());
    const { modal } = await getRenderedModalDialog(container);

    modal.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    modal.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    modal.dispatchEvent(chord("Enter", { altKey: true }));

    expect(onDecision).not.toHaveBeenCalled();
  });

  it("ignores auto-repeated shortcut keydown events", async () => {
    const { onDecision } = await renderApproval(createExecRequest());
    const { modal } = await getRenderedModalDialog(container);

    modal.dispatchEvent(chord("Enter", { repeat: true }));
    modal.dispatchEvent(chord("Enter", { shiftKey: true, repeat: true }));

    expect(onDecision).not.toHaveBeenCalled();
  });

  it("keeps the displayed approval pinned when an older request arrives", async () => {
    const newer = createExecRequest({ id: "approval-newer", createdAtMs: 2_000 });
    const older = createExecRequest({ id: "approval-older", createdAtMs: 1_000 });
    const { approval } = await renderApproval([newer]);
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

  it("repins the modal card when its selection becomes inline", async () => {
    const selected = createExecRequest({ id: "approval-selected", createdAtMs: 2_000 });
    const displayedHead = createExecRequest({ id: "approval-head", createdAtMs: 1_000 });
    const olderArrival = createExecRequest({ id: "approval-older", createdAtMs: 500 });
    const { approval } = await renderApproval([displayedHead, selected]);
    await getRenderedModalDialog(container);

    container.querySelector<HTMLButtonElement>(".exec-approval-list__item")?.click();
    await approval.updateComplete;
    expect(container.querySelector(".exec-approval-card")?.getAttribute("data-approval-id")).toBe(
      "approval-selected",
    );

    await renderApproval([displayedHead, selected], { inlineApprovalId: selected.id });
    await approval.updateComplete;
    expect(container.querySelector(".exec-approval-card")?.getAttribute("data-approval-id")).toBe(
      "approval-head",
    );

    await renderApproval([olderArrival, displayedHead, selected], {
      inlineApprovalId: selected.id,
    });
    await approval.updateComplete;
    expect(container.querySelector(".exec-approval-card")?.getAttribute("data-approval-id")).toBe(
      "approval-head",
    );
  });

  it("guards shortcuts while busy, disallowed, or focused in text input", async () => {
    const restricted = createExecRequest({
      request: { command: "echo hello", allowedDecisions: ["allow-once", "deny"] },
    });
    const onDecision = vi.fn();
    await renderApproval(restricted, { busy: true, onDecision });
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

  it("suppresses the automatic modal for the inline request but opens it on demand", async () => {
    const { approval } = await renderApproval(createExecRequest(), {
      inlineApprovalId: "approval-1",
    });
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();

    (approval as LitElement & { show(): void }).show();
    await approval.updateComplete;

    expect(container.querySelector("openclaw-modal-dialog")).not.toBeNull();
  });

  it("keeps unrelated requests modal while one active-session request is inline", async () => {
    await renderApproval(
      [
        createExecRequest({ id: "approval-inline" }),
        createExecRequest({ id: "approval-other", request: { command: "pnpm test" } }),
      ],
      { inlineApprovalId: "approval-inline" },
    );

    await getRenderedModalDialog(container);
    expect(container.querySelector(".exec-approval-card")?.getAttribute("data-approval-id")).toBe(
      "approval-other",
    );
  });

  it("resets manual show-all after the approval queue drains", async () => {
    let rendered = await renderApproval(createExecRequest(), { inlineApprovalId: "approval-1" });
    (rendered.approval as LitElement & { show(): void }).show();
    await rendered.approval.updateComplete;
    expect(container.querySelector("openclaw-modal-dialog")).not.toBeNull();

    rendered = await renderApproval([], { inlineApprovalId: null });
    await rendered.approval.updateComplete;
    await renderApproval(createExecRequest(), { inlineApprovalId: "approval-1" });

    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
  });
});
