/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { AppViewState } from "../app-view-state.ts";
import { type OpenClawModalDialog } from "../components/modal-dialog.ts";
import type { ExecApprovalRequest } from "../controllers/exec-approval.ts";
import { renderDreamingRestartConfirmation } from "./dreaming-restart-confirmation.ts";
import { renderExecApprovalPrompt } from "./exec-approval.ts";
import { renderGatewayUrlConfirmation } from "./gateway-url-confirmation.ts";

let container: HTMLDivElement;

const showModalDescriptor = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
const closeDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function installDialogPolyfill() {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
}

function restoreDescriptor(name: "showModal" | "close", descriptor?: PropertyDescriptor) {
  if (descriptor) {
    Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    return;
  }
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)[name];
}

async function getRenderedDialog() {
  const modal = container.querySelector<OpenClawModalDialog>("openclaw-modal-dialog");
  expect(modal).toBeInstanceOf(HTMLElement);
  if (!modal) {
    throw new Error("Expected openclaw-modal-dialog");
  }
  await modal.updateComplete;
  await nextFrame();
  const dialog = modal.shadowRoot?.querySelector("dialog");
  expect(dialog).toBeInstanceOf(HTMLDialogElement);
  if (!(dialog instanceof HTMLDialogElement)) {
    throw new Error("Expected rendered dialog");
  }
  return { modal, dialog };
}

function dispatchEscape(target: EventTarget) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );
}

function createExecRequest(): ExecApprovalRequest {
  return {
    id: "approval-1",
    kind: "exec",
    request: {
      command: "echo hello",
      host: "gateway",
      cwd: "/tmp/openclaw",
      security: "workspace-write",
      ask: "on-request",
    },
    createdAtMs: Date.now() - 1_000,
    expiresAtMs: Date.now() + 60_000,
  };
}

function createExecState(
  overrides: Partial<
    Pick<
      AppViewState,
      "execApprovalBusy" | "execApprovalError" | "execApprovalQueue" | "handleExecApprovalDecision"
    >
  > = {},
): AppViewState {
  return {
    execApprovalQueue: [createExecRequest()],
    execApprovalBusy: false,
    execApprovalError: null,
    handleExecApprovalDecision: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as AppViewState;
}

describe("approval and confirmation modals", () => {
  beforeEach(async () => {
    installDialogPolyfill();
    vi.stubGlobal("localStorage", createStorageMock());
    await i18n.setLocale("en");
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    render(nothing, container);
    container.remove();
    await i18n.setLocale("en");
    restoreDescriptor("showModal", showModalDescriptor);
    restoreDescriptor("close", closeDescriptor);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders exec approval as a labelled modal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
    render(renderExecApprovalPrompt(createExecState()), container);
    vi.useRealTimers();

    const { modal, dialog } = await getRenderedDialog();

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("openclaw-modal-dialog-label");
    expect(dialog.getAttribute("aria-describedby")).toBe("openclaw-modal-dialog-description");
    expect(modal.shadowRoot?.querySelector("#openclaw-modal-dialog-label")?.textContent).toBe(
      "Exec approval needed",
    );
    expect(
      modal.shadowRoot?.querySelector("#openclaw-modal-dialog-description")?.textContent?.trim(),
    ).toBe("expires in 1m");
    expect(container.querySelector("#exec-approval-title")?.textContent?.trim()).toBe(
      "Exec approval needed",
    );
    expect(container.querySelector("#exec-approval-description")?.textContent?.trim()).toBe(
      "expires in 1m",
    );
  });

  it("renders command spans in exec approvals", async () => {
    const request = createExecRequest();
    request.request.command = 'ls | grep "stuff" | python -c \'print("hi")\'';
    request.request.commandSpans = [
      { startIndex: 0, endIndex: 2 },
      { startIndex: 5, endIndex: 5 },
      { startIndex: 8.5, endIndex: 10 },
      { startIndex: 20, endIndex: 29 },
      { startIndex: 30, endIndex: 200 },
    ];

    render(renderExecApprovalPrompt(createExecState({ execApprovalQueue: [request] })), container);

    await getRenderedDialog();

    const spans = [...container.querySelectorAll(".exec-approval-command-span")].map(
      (span) => span.textContent,
    );
    expect(spans).toEqual(["ls", "python -c"]);
  });

  it("maps Escape to exec denial when approval is idle", async () => {
    const handleExecApprovalDecision = vi.fn(async () => undefined);
    render(renderExecApprovalPrompt(createExecState({ handleExecApprovalDecision })), container);

    const { dialog } = await getRenderedDialog();
    dispatchEscape(dialog);

    expect(handleExecApprovalDecision).toHaveBeenCalledTimes(1);
    expect(handleExecApprovalDecision).toHaveBeenCalledWith("deny");
  });

  it("does not dispatch an extra exec decision from Escape while busy", async () => {
    const handleExecApprovalDecision = vi.fn(async () => undefined);
    render(
      renderExecApprovalPrompt(
        createExecState({ execApprovalBusy: true, handleExecApprovalDecision }),
      ),
      container,
    );

    const { dialog } = await getRenderedDialog();
    dispatchEscape(dialog);

    expect(handleExecApprovalDecision).not.toHaveBeenCalled();
  });

  it("renders exec approval chrome from the active locale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
    await i18n.setLocale("zh-CN");
    const active: ExecApprovalRequest = {
      id: "approval-1",
      kind: "exec",
      request: {
        command: "pnpm check:changed",
        host: "gateway",
        agentId: "main",
        sessionKey: "main",
        cwd: "/tmp/project",
        resolvedPath: "/tmp/project",
        security: "workspace-write",
        ask: "on-request",
      },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 61_000,
    };
    const queued: ExecApprovalRequest = {
      ...active,
      id: "approval-2",
      createdAtMs: Date.now() + 1,
      expiresAtMs: Date.now() + 62_000,
    };

    render(
      renderExecApprovalPrompt(createExecState({ execApprovalQueue: [active, queued] })),
      container,
    );

    expect(container.querySelector("#exec-approval-title")?.textContent?.trim()).toBe(
      "需要 Exec 审批",
    );
    expect(container.querySelector("#exec-approval-description")?.textContent?.trim()).toBe(
      "1m 后过期",
    );
    expect(container.querySelector(".exec-approval-queue")?.textContent?.trim()).toBe("2 个待处理");
    expect(container.querySelector(".exec-approval-command")?.textContent?.trim()).toBe(
      "pnpm check:changed",
    );
    expect(
      Array.from(container.querySelectorAll(".exec-approval-meta-row")).map((row) => {
        const [label, value] = Array.from(row.querySelectorAll("span")).map((span) =>
          span.textContent?.trim(),
        );
        return { label, value };
      }),
    ).toEqual([
      { label: "主机", value: "gateway" },
      { label: "代理", value: "main" },
      { label: "会话", value: "main" },
      { label: "CWD", value: "/tmp/project" },
      { label: "已解析", value: "/tmp/project" },
      { label: "安全", value: "workspace-write" },
      { label: "询问策略", value: "on-request" },
    ]);
    expect(
      Array.from(container.querySelectorAll(".exec-approval-actions button")).map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["允许一次", "始终允许", "拒绝"]);
  });

  it("uses the shared modal primitive for gateway URL confirmation and cancels on Escape", async () => {
    const handleGatewayUrlCancel = vi.fn();
    render(
      renderGatewayUrlConfirmation({
        pendingGatewayUrl: "wss://gateway.example/openclaw",
        handleGatewayUrlConfirm: vi.fn(),
        handleGatewayUrlCancel,
      } as unknown as AppViewState),
      container,
    );

    const { dialog } = await getRenderedDialog();

    dispatchEscape(dialog);

    expect(handleGatewayUrlCancel).toHaveBeenCalledTimes(1);
  });

  it("uses the shared modal primitive for dreaming restart confirmation and cancels on Escape", async () => {
    const onCancel = vi.fn();
    render(
      renderDreamingRestartConfirmation({
        open: true,
        loading: false,
        onConfirm: vi.fn(),
        onCancel,
        hasError: false,
      }),
      container,
    );

    const { dialog } = await getRenderedDialog();

    dispatchEscape(dialog);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not cancel dreaming restart from Escape while loading", async () => {
    const onCancel = vi.fn();
    render(
      renderDreamingRestartConfirmation({
        open: true,
        loading: true,
        onConfirm: vi.fn(),
        onCancel,
        hasError: false,
      }),
      container,
    );

    const { dialog } = await getRenderedDialog();
    dispatchEscape(dialog);

    expect(onCancel).not.toHaveBeenCalled();
  });
});
