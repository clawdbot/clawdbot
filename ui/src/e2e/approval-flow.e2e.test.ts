// Control UI E2E tests cover approval queue behavior through the Gateway WebSocket.
import type { Page } from "playwright";
import { afterEach, expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI approval flow",
});

// Browser contexts preserve test isolation; keep one process warm for this file.
let page: Page | undefined;
function approval(id: string, command: string, createdAtMs: number) {
  return {
    id,
    createdAtMs,
    expiresAtMs: Date.now() + 60_000,
    request: { command },
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
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
    const gateway = await installMockGateway(currentPage);

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await gateway.waitForRequest("sessions.list");
    await gateway.deferNext("exec.approval.resolve");
    await gateway.emitGatewayEvent(
      "exec.approval.requested",
      approval("approval-active", "echo active", 1_000),
    );
    await currentPage.getByText("echo active", { exact: true }).waitFor();
    await currentPage.getByRole("button", { name: "Allow once" }).click();

    await gateway.emitGatewayEvent(
      "exec.approval.requested",
      approval("approval-newer", "echo newer", 2_000),
    );
    await currentPage.getByText("echo newer", { exact: true }).waitFor();
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

    await currentPage.getByText("echo newer", { exact: true }).click();
    await expect
      .poll(() => currentPage.locator(".exec-approval-card").getAttribute("data-approval-id"))
      .toBe("approval-newer");
    await expect.poll(() => currentPage.locator(".exec-approval-error").count()).toBe(0);
    await expect
      .poll(() => currentPage.getByRole("button", { name: "Deny" }).isEnabled())
      .toBe(true);
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
