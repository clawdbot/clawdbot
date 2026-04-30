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
  expect(modal).not.toBeNull();
  await modal!.updateComplete;
  await nextFrame();
  const dialog = modal!.shadowRoot?.querySelector("dialog");
  expect(dialog).not.toBeNull();
  return { modal: modal!, dialog: dialog! };
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
    render(renderExecApprovalPrompt(createExecState()), container);

    const { modal, dialog } = await getRenderedDialog();

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("openclaw-modal-dialog-label");
    expect(dialog.getAttribute("aria-describedby")).toBe("openclaw-modal-dialog-description");
    expect(modal.shadowRoot?.querySelector("#openclaw-modal-dialog-label")?.textContent).toBe(
      "Exec approval needed",
    );
    expect(
      modal.shadowRoot?.querySelector("#openclaw-modal-dialog-description")?.textContent,
    ).toContain("expires in");
    expect(container.querySelector("#exec-approval-title")?.textContent).toContain(
      "Exec approval needed",
    );
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

    expect(container.textContent).toContain("需要 Exec 审批");
    expect(container.textContent).toContain("1m 后过期");
    expect(container.textContent).toContain("2 个待处理");
    expect(container.textContent).toContain("主机");
    expect(container.textContent).toContain("代理");
    expect(container.textContent).toContain("允许一次");
    expect(container.textContent).toContain("始终允许");
    expect(container.textContent).toContain("拒绝");
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
    expect(container.querySelector("openclaw-modal-dialog")).not.toBeNull();

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
    expect(container.querySelector("openclaw-modal-dialog")).not.toBeNull();

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
