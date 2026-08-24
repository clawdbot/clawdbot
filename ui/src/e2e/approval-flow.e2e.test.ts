// Control UI E2E tests cover approval queue behavior through the Gateway WebSocket.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { Page } from "playwright";
import { afterEach, expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI approval flow",
});

// Browser contexts preserve test isolation; keep one process warm for this file.
let page: Page | undefined;
const activeSessionKey = "agent:main:main";
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "approval-flow");

function approval(id: string, command: string, createdAtMs: number, sessionKey = activeSessionKey) {
  return {
    id,
    createdAtMs,
    expiresAtMs: Date.now() + 60_000,
    request: { command, agentId: "main", sessionKey },
  };
}

const requireRecord = createRequireRecord("record", "expected-object-value");

function approvalInboxButton(currentPage: Page) {
  return currentPage.locator("openclaw-sidebar-attention .sidebar-issues-button");
}

function approvalInboxPanel(currentPage: Page) {
  return currentPage.locator("openclaw-sidebar-attention #sidebar-issues-panel");
}

suite.define(() => {
  afterEach(async () => {
    await page
      ?.context()
      .close()
      .catch(() => {});
    page = undefined;
  });

  it("keeps a resolve failure scoped to its approval when a newer one arrives", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, { sessionKey: activeSessionKey });

    await currentPage.goto(controlUiSessionUrl(suite.server?.baseUrl ?? "", activeSessionKey));
    await gateway.waitForRequest("sessions.list");
    await gateway.deferNext("exec.approval.resolve");
    await gateway.emitGatewayEvent(
      "exec.approval.requested",
      approval("approval-active", "echo active", 1_000),
    );
    await currentPage.getByText("echo active", { exact: true }).waitFor();
    await currentPage.getByRole("button", { name: "Allow once" }).focus();
    expect(
      await currentPage
        .getByRole("button", { name: "Allow once" })
        .evaluate((button) => button === document.activeElement),
    ).toBe(true);
    await currentPage.getByRole("button", { name: "Allow once" }).click();

    await gateway.emitGatewayEvent(
      "exec.approval.requested",
      approval("approval-newer", "echo newer", 2_000),
    );
    await approvalInboxButton(currentPage).waitFor();
    await gateway.rejectDeferred("exec.approval.resolve", {
      code: "UNAVAILABLE",
      message: "gateway unavailable",
    });

    await expect
      .poll(() =>
        currentPage
          .locator('[data-approval-id="approval-active"] .exec-approval-error')
          .textContent(),
      )
      .toBe("Approval failed: gateway unavailable");

    await approvalInboxButton(currentPage).click();
    const newerRow = approvalInboxPanel(currentPage).locator('[data-approval-id="approval-newer"]');
    await expect
      .poll(() => newerRow.locator(".sidebar-approval-row__command").textContent())
      .toContain("echo newer");
    await expect.poll(() => newerRow.locator('[role="alert"]').count()).toBe(0);
    await expect.poll(() => newerRow.getByRole("button", { name: /Deny/ }).isEnabled()).toBe(true);
  });

  it("keeps approvals passive until the Inbox opens the full queue", async () => {
    if (captureUiProof) {
      await mkdir(proofDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      viewport: { height: 800, width: 1200 },
      ...(captureUiProof
        ? { recordVideo: { dir: proofDir, size: { height: 800, width: 1200 } } }
        : {}),
    });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, { sessionKey: activeSessionKey });

    await currentPage.goto(controlUiSessionUrl(suite.server?.baseUrl ?? "", activeSessionKey));
    await gateway.waitForRequest("sessions.list");
    await gateway.emitGatewayEvent(
      "exec.approval.requested",
      approval("approval-inline", "echo inline", 1_000),
    );

    await currentPage
      .locator('.chat-inline-approval [data-approval-id="approval-inline"]')
      .waitFor();
    expect(await currentPage.locator("openclaw-modal-dialog").count()).toBe(0);

    await gateway.emitGatewayEvent(
      "exec.approval.requested",
      approval("approval-other", "echo other", 2_000, "agent:main:other"),
    );

    await approvalInboxButton(currentPage).waitFor();
    expect(await currentPage.locator("openclaw-modal-dialog").count()).toBe(0);
    expect(await currentPage.getByText("echo other", { exact: true }).count()).toBe(0);
    if (captureUiProof) {
      await currentPage.screenshot({ path: path.join(proofDir, "01-passive-attention.png") });
    }

    await approvalInboxButton(currentPage).click();
    const inboxPanel = approvalInboxPanel(currentPage);
    await inboxPanel.locator('[data-approval-id="approval-inline"]').waitFor();
    await inboxPanel.locator('[data-approval-id="approval-other"]').waitFor();
    await expect.poll(() => inboxPanel.locator("[data-approval-id]").count()).toBe(2);
    await inboxPanel.getByRole("tab", { name: "Approvals 2" }).waitFor();
    if (captureUiProof) {
      await currentPage.screenshot({ path: path.join(proofDir, "02-open-queue.png") });
    }
  });

  it("keeps no-auth inline and Inbox approvals readable while blocking decisions", async () => {
    if (captureUiProof) {
      await mkdir(proofDir, { recursive: true });
    }
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, {
      omitConnectHelloAuth: true,
      sessionKey: activeSessionKey,
    });

    await currentPage.goto(controlUiSessionUrl(suite.server?.baseUrl ?? "", activeSessionKey));
    await gateway.waitForRequest("sessions.list");
    await gateway.emitGatewayEvent(
      "exec.approval.requested",
      approval("approval-review-only", "echo review only", 1_000),
    );

    const inlineCard = currentPage.locator(
      '.chat-inline-approval [data-approval-id="approval-review-only"]',
    );
    await inlineCard.waitFor();
    await inlineCard.getByText("echo review only", { exact: true }).waitFor();
    await inlineCard
      .getByText("Review only. Sign in with approval access to record a decision.", {
        exact: true,
      })
      .waitFor();
    const inlineDecisionButtons = inlineCard.locator(".exec-approval-actions button");
    expect(await inlineDecisionButtons.count()).toBe(3);
    expect(
      await inlineDecisionButtons.evaluateAll((buttons) =>
        buttons.every((button) => (button as HTMLButtonElement).disabled),
      ),
    ).toBe(true);
    if (captureUiProof) {
      await currentPage.screenshot({ path: path.join(proofDir, "review-only-inline.png") });
    }

    await approvalInboxButton(currentPage).click();
    const inboxPanel = approvalInboxPanel(currentPage);
    const inboxRow = inboxPanel.locator('[data-approval-id="approval-review-only"]');
    await expect
      .poll(() => inboxRow.locator(".sidebar-approval-row__command").textContent())
      .toContain("echo review only");
    await inboxRow
      .getByText("Review only. Sign in with approval access to record a decision.", {
        exact: true,
      })
      .waitFor();
    const inboxDecisionButtons = inboxRow.locator(".sidebar-approval-row__actions button");
    expect(await inboxDecisionButtons.count()).toBe(3);
    expect(
      await inboxDecisionButtons.evaluateAll((buttons) =>
        buttons.every((button) => (button as HTMLButtonElement).disabled),
      ),
    ).toBe(true);

    if (captureUiProof) {
      await currentPage.screenshot({ path: path.join(proofDir, "review-only-inbox.png") });
    }
  });

  it("sends a typed approval command immediately while the active run waits", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage);

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await gateway.waitForRequest("sessions.list");

    const composer = currentPage.locator(".agent-chat__composer-combobox textarea");
    await composer.fill("run a command that needs approval");
    await currentPage.getByRole("button", { name: "Send message" }).click();
    const firstSend = requireRecord((await gateway.waitForRequest("chat.send")).params);
    expect(firstSend.message).toBe("run a command that needs approval");
    await currentPage.getByRole("button", { name: "Stop generating" }).waitFor();

    await composer.fill("/approve approval-123 allow-once");
    await currentPage.getByRole("button", { name: "Send message" }).click();

    await expect
      .poll(async () => (await gateway.getRequests("chat.send")).length, { timeout: 10_000 })
      .toBe(2);
    const sends = await gateway.getRequests("chat.send");
    const approvalSend = requireRecord(sends[1]?.params);
    expect(approvalSend.message).toBe("/approve approval-123 allow-once");
    expect(approvalSend.deliver).toBe(false);
    expect(typeof approvalSend.idempotencyKey).toBe("string");
    expect(await currentPage.locator(".chat-queue").count()).toBe(0);
    expect(await composer.inputValue()).toBe("");
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(1);
  });
});
