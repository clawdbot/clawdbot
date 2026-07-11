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

async function renderApproval(request: ExecApprovalRequest) {
  render(
    html`<openclaw-exec-approval
      .props=${{
        queue: [request],
        busy: false,
        error: null,
        onDecision: vi.fn(),
      }}
    ></openclaw-exec-approval>`,
    container,
  );
  const approval = container.querySelector<LitElement>("openclaw-exec-approval");
  if (!approval) {
    throw new Error("Expected exec approval");
  }
  await approval.updateComplete;
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
      Array.from(container.querySelectorAll(".exec-approval-actions button")).map((button) =>
        button.textContent?.trim(),
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
      Array.from(container.querySelectorAll(".exec-approval-actions button")).map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Allow once", "Deny"]);
    expect(container.querySelector(".exec-approval-warning")).toBeNull();
  });
});
