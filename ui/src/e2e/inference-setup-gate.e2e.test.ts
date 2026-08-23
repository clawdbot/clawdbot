import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "inference-setup-gate");

async function captureProof(page: import("playwright").Page, fileName: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, fileName),
  });
}

suite.define(() => {
  it("blocks empty chat home until a model is connected", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, { agentModel: null });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByRole("heading", { name: "No AI provider configured" }).waitFor();

      await expect.poll(() => page.locator(".agent-chat__composer-shell").count()).toBe(0);
      await expect.poll(() => page.locator("textarea").count()).toBe(0);
      await expect
        .poll(() => page.getByRole("button", { name: "Connect an AI provider" }).count())
        .toBe(1);
      await captureProof(page, "chat-home-desktop.png");
      await page.getByRole("button", { name: "Connect an AI provider" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-setup");
    } finally {
      await context.close();
    }
  });

  it("shows retryable model setup when first-run detection stays unavailable", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      agentModel: null,
      deferredMethods: ["openclaw.setup.detect"],
      featureMethods: ["openclaw.setup.detect"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("openclaw.setup.detect");
      await gateway.deferNext("openclaw.setup.detect");
      await gateway.rejectDeferred("openclaw.setup.detect", {
        code: "UNAVAILABLE",
        message: "temporary setup detection failure",
      });

      await gateway.waitForRequest("openclaw.setup.detect", { after: 1 });
      await gateway.deferNext("openclaw.setup.detect");
      await gateway.rejectDeferred("openclaw.setup.detect", {
        code: "UNAVAILABLE",
        message: "setup detection still unavailable",
      });

      await gateway.waitForRequest("openclaw.setup.detect", { after: 2 });
      await gateway.rejectDeferred("openclaw.setup.detect", {
        code: "UNAVAILABLE",
        message: "setup detection unavailable on recovery page",
      });

      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-setup");
      await page.getByRole("alert").waitFor();
      await expect.poll(() => page.getByRole("button", { name: "Retry" }).count()).toBe(1);
      await captureProof(page, "first-run-detection-recovery.png");
    } finally {
      await context.close();
    }
  });

  it("blocks the new-session composer until a model is connected", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, { agentModel: null });

    try {
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await page.getByRole("heading", { name: "No AI provider configured" }).waitFor();

      await expect.poll(() => page.locator(".new-session-page__composer").count()).toBe(0);
      await expect.poll(() => page.locator("textarea").count()).toBe(0);
      await captureProof(page, "new-session-desktop.png");
      await page.getByRole("button", { name: "Connect an AI provider" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-setup");
    } finally {
      await context.close();
    }
  });

  it("shows the setup splash before starting custodian chat", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1660 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      agentModel: null,
      featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}custodian`);
      await page.getByRole("heading", { name: "No AI provider configured" }).waitFor();

      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
      await expect.poll(() => page.locator(".custodian__error").count()).toBe(0);
      await expect.poll(() => page.locator(".agent-chat__composer-shell").count()).toBe(0);
      await expect.poll(() => page.locator("textarea").count()).toBe(0);
      await expect
        .poll(async () => (await page.locator(".custodian__header").boundingBox())?.width ?? 0)
        .toBeGreaterThan(1_000);
      await captureProof(page, "custodian-desktop.png");

      await page.setViewportSize({ height: 520, width: 900 });
      await expect
        .poll(() => page.getByRole("button", { name: "Connect an AI provider" }).isVisible())
        .toBe(true);
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        )
        .toBe(true);
      await captureProof(page, "custodian-short-window.png");

      await page.setViewportSize({ height: 900, width: 1660 });
      await page.getByRole("button", { name: "Connect an AI provider" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-setup");
      const modelsLink = page.locator('.settings-sidebar__item[href="/settings/model-providers"]');
      await expect.poll(() => modelsLink.getAttribute("aria-current")).toBe("page");
      await captureProof(page, "custodian-model-setup-selected.png");
    } finally {
      await context.close();
    }
  });

  it("distinguishes a configured provider that fails its live check", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1660 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["openclaw.chat"],
      featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat"],
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "OpenClaw" },
              model: { primary: "openai/gpt-5.5" },
              name: "OpenClaw",
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}custodian`);
      await gateway.waitForRequest("openclaw.chat");
      await gateway.rejectDeferred("openclaw.chat", {
        code: "UNAVAILABLE",
        details: { code: "system_agent_inference_unavailable" },
        message: "OpenClaw requires working inference: provider authentication failed",
      });

      await page.getByRole("heading", { name: "Configured AI needs attention" }).waitFor();
      await expect.poll(() => page.locator(".agent-chat__composer-shell").count()).toBe(0);
      await expect
        .poll(() => page.getByRole("button", { name: "Review connection" }).count())
        .toBe(1);
      await expect.poll(() => page.getByRole("button", { name: "Retry" }).count()).toBe(1);
      await captureProof(page, "custodian-provider-unavailable.png");

      await page.getByRole("button", { name: "Review connection" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-setup");
      const modelsLink = page.locator('.settings-sidebar__item[href="/settings/model-providers"]');
      await expect.poll(() => modelsLink.getAttribute("aria-current")).toBe("page");
    } finally {
      await context.close();
    }
  });
});
