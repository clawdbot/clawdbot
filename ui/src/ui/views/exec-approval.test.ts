/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { AppViewState } from "../app-view-state.ts";
import type { ExecApprovalRequest } from "../controllers/exec-approval.ts";
import { renderDreamingRestartConfirmation } from "./dreaming-restart-confirmation.ts";
import { renderExecApprovalPrompt } from "./exec-approval.ts";
import { renderGatewayUrlConfirmation } from "./gateway-url-confirmation.ts";

let container: HTMLDivElement;
let restoreDialogPolyfill: () => void;

async function getRenderedDialog() {
  return await getRenderedModalDialog(container);
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
    restoreDialogPolyfill = installDialogPolyfill();
    vi.stubGlobal("localStorage", createStorageMock());
    await i18n.setLocale("en");
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    render(nothing, container);
    container.remove();
    await i18n.setLocale("en");
    restoreDialogPolyfill();
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

  it("does not render a visible neutral dismiss action", async () => {
    render(renderExecApprovalPrompt(createExecState()), container);

    await getRenderedDialog();

    expect(
      Array.from(container.querySelectorAll(".exec-approval-actions button")).map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Allow once", "Always allow", "Deny"]);
  });

  it("hides unavailable exec approval decisions", async () => {
    const request = createExecRequest();
    request.request.ask = "always";
    request.request.allowedDecisions = ["allow-once", "deny"];

    render(renderExecApprovalPrompt(createExecState({ execApprovalQueue: [request] })), container);

    await getRenderedDialog();

    expect(
      Array.from(container.querySelectorAll(".exec-approval-actions button")).map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Allow once", "Deny"]);
    expect(container.querySelector(".exec-approval-warning")?.textContent?.trim()).toBe(
      "The effective approval policy requires approval every time, so Allow Always is unavailable.",
    );
  });

  it("falls back to ask when exec approval decisions are omitted", async () => {
    const request = createExecRequest();
    request.request.ask = "always";
    request.request.allowedDecisions = undefined;

    render(renderExecApprovalPrompt(createExecState({ execApprovalQueue: [request] })), container);

    await getRenderedDialog();

    expect(
      Array.from(container.querySelectorAll(".exec-approval-actions button")).map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Allow once", "Deny"]);
  });

  it("keeps durable exec approval when the request allows it", async () => {
    const request = createExecRequest();
    request.request.allowedDecisions = ["allow-once", "allow-always", "deny"];

    render(renderExecApprovalPrompt(createExecState({ execApprovalQueue: [request] })), container);

    await getRenderedDialog();

    expect(
      Array.from(container.querySelectorAll(".exec-approval-actions button")).map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Allow once", "Always allow", "Deny"]);
    expect(container.querySelector(".exec-approval-warning")).toBeNull();
  });

  it("does not show exec policy warning for restricted plugin approvals", async () => {
    const request: ExecApprovalRequest = {
      id: "plugin-approval-1",
      kind: "plugin",
      request: {
        command: "Plugin approval",
        allowedDecisions: ["allow-once", "deny"],
      },
      pluginTitle: "Plugin approval",
      createdAtMs: Date.now() - 1_000,
      expiresAtMs: Date.now() + 60_000,
    };

    render(renderExecApprovalPrompt(createExecState({ execApprovalQueue: [request] })), container);

    await getRenderedDialog();

    expect(
      Array.from(container.querySelectorAll(".exec-approval-actions button")).map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Allow once", "Deny"]);
    expect(container.querySelector(".exec-approval-warning")).toBeNull();
  });

  it("maps Escape to exec denial when approval is idle", async () => {
    const handleExecApprovalDecision = vi.fn(async () => undefined);
    render(renderExecApprovalPrompt(createExecState({ handleExecApprovalDecision })), container);

    const { dialog } = await getRenderedDialog();

    dispatchEscape(dialog);

    expect(handleExecApprovalDecision).toHaveBeenCalledWith("deny");
  });

  it("renders plugin command actions and only available decision buttons", async () => {
    const handleExecApprovalDecision = vi.fn(async () => undefined);
    const request: ExecApprovalRequest = {
      id: "plugin-approval-1",
      kind: "plugin",
      request: {
        command: "World proof required",
        agentId: "main",
        sessionKey: "main",
      },
      pluginTitle: "World proof required",
      pluginDescription: "Verify with World before exec runs.",
      pluginSeverity: "warning",
      pluginId: "agentkit",
      allowedDecisions: ["deny"],
      actions: [
        {
          kind: "command",
          label: "Verify once",
          style: "primary",
          command: "/agentkit approve plugin-approval-1 allow-once",
        },
      ],
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };

    render(
      renderExecApprovalPrompt(
        createExecState({ execApprovalQueue: [request], handleExecApprovalDecision }),
      ),
      container,
    );
    await getRenderedDialog();

    expect(container.querySelector(".exec-approval-command-action")?.textContent).toContain(
      "/agentkit approve plugin-approval-1 allow-once",
    );
    const buttons = Array.from(container.querySelectorAll(".exec-approval-actions button")).map(
      (button) => button.textContent?.trim(),
    );
    expect(buttons).toEqual(["Deny"]);

    container.querySelector<HTMLButtonElement>(".exec-approval-actions button")?.click();
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

  it("does not dispatch denied from Escape when denial is unavailable", async () => {
    const request = createExecRequest();
    request.request.allowedDecisions = ["allow-once"];
    const handleExecApprovalDecision = vi.fn(async () => undefined);
    render(
      renderExecApprovalPrompt(
        createExecState({ execApprovalQueue: [request], handleExecApprovalDecision }),
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
