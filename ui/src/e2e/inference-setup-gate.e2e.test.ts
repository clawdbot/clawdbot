import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createNewSessionPageE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
let proofDir: string;
beforeEach(() => {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    proofDir = createControlUiE2eArtifactDir("inference-setup-gate");
  }
});

async function captureProof(page: import("playwright").Page, fileName: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
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

  it.each(["page", "panel"])(
    "keeps %s history and the runtime error visible until retry succeeds",
    async (surface) => {
      const viewport = { height: 900, width: 1660 };
      const context = await suite.browser.newContext({
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        ...(process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
          ? { recordVideo: { dir: proofDir, size: viewport } }
          : {}),
      });
      const page = await context.newPage();
      const runtimeError =
        "OpenClaw requires working inference: The configured runtime could not start. Repair the launcher and retry.";
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:work",
        deferredMethods: ["openclaw.chat"],
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "chat.history",
          "chat.send",
          "openclaw.chat",
          "openclaw.chat.history",
        ],
        methodResponses: {
          "openclaw.chat.history": {
            turns: [
              {
                role: "assistant",
                text: "Your earlier conversation is still here.",
                at: 1_700_000_101_000,
              },
            ],
          },
        },
      });

      try {
        await page.goto(
          surface === "page"
            ? `${suite.server.baseUrl}custodian`
            : controlUiSessionUrl(suite.server.baseUrl, "agent:main:work"),
        );
        if (surface === "panel") {
          await page.locator(".sidebar-footer-bar__home").click();
          await page
            .locator("openclaw-assistant-panel")
            .getByRole("button", { name: "Ask OpenClaw", exact: true })
            .click();
        }
        const chat = page.locator("openclaw-custodian-surface");
        await gateway.waitForRequest("openclaw.chat");
        await gateway.rejectDeferred("openclaw.chat", {
          code: "UNAVAILABLE",
          details: { code: "system_agent_inference_unavailable" },
          message: runtimeError,
        });
        await chat.locator(".custodian__setup-state, .custodian__error").waitFor();
        await captureProof(page, "01-runtime-error.png");
        await expect
          .poll(() => chat.locator(".custodian__error").textContent())
          .toContain(runtimeError);
        await chat.getByText("Your earlier conversation is still here.").waitFor();
        expect(await chat.getByRole("button", { name: "Review connection" }).count()).toBe(0);
        expect(await chat.locator(".agent-chat__composer-shell").count()).toBe(1);
        expect(await chat.getByRole("textbox").isDisabled()).toBe(true);

        // Each deferral is consumed by one request, including the failed startup check.
        await gateway.deferNext("openclaw.chat");
        await chat.getByRole("button", { name: "Retry", exact: true }).click();
        const retry = await gateway.waitForRequest("openclaw.chat", { after: 1 });
        expect(retry.params).not.toHaveProperty("message");
        expect(await chat.getByRole("textbox").isDisabled()).toBe(true);
        await gateway.resolveDeferred("openclaw.chat", {
          sessionId: "runtime-recovered",
          reply: "Ready to help again.",
          action: "none",
        });
        await chat.getByText("Ready to help again.").waitFor();
        await expect.poll(() => chat.getByRole("textbox").isEnabled()).toBe(true);
        expect(await chat.locator(".custodian__error").count()).toBe(0);
        await captureProof(page, "02-runtime-recovered.png");

        await gateway.deferNext("openclaw.chat", { message: "Check my setup" });
        await chat.getByRole("textbox").fill("Check my setup");
        await chat.getByRole("button", { name: "Send", exact: true }).click();
        const turn = await gateway.waitForRequest("openclaw.chat", { after: 2 });
        expect(turn.params).toMatchObject({ message: "Check my setup" });
        await gateway.resolveDeferred("openclaw.chat", {
          sessionId: "runtime-recovered",
          reply: "Your setup is working.",
          action: "none",
        });
        await chat.getByText("Your setup is working.").waitFor();
        await captureProof(page, "03-user-turn-succeeded.png");
      } finally {
        await context.close();
      }
    },
  );
});
