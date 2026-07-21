// Control UI tests cover guided model setup against a mocked Gateway.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI Model Setup mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("hands first-run model setup to the custodian in onboarding chrome", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "openclaw.setup.detect",
        "openclaw.setup.activate",
        "openclaw.chat",
      ],
      methodResponses: {
        "openclaw.setup.detect": {
          candidates: [
            {
              kind: "codex-cli",
              label: "Codex CLI",
              detail: "Signed in locally",
              modelRef: "openai/gpt-5",
              recommended: true,
              credentials: true,
            },
          ],
          manualProviders: [{ id: "openai", label: "OpenAI" }],
          workspace: "/tmp/openclaw-e2e",
          setupComplete: false,
        },
        "openclaw.setup.activate": {
          ok: true,
          modelRef: "openai/gpt-5",
          latencyMs: 73,
          lines: ["Model ready"],
        },
        "openclaw.chat": {
          sessionId: "e2e-custodian",
          reply: "## Hi, I'm OpenClaw",
          action: "none",
          question: {
            id: "onboarding-next-step",
            header: "Next step",
            question: "What would you like to do first?",
            options: [
              { label: "Talk to my agent", reply: "talk to agent", recommended: true },
              { label: "Connect WhatsApp", reply: "connect whatsapp" },
            ],
            isOther: true,
            skipAction: "exit",
          },
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/model-setup?firstRun=1`);
      expect(response?.status()).toBe(200);
      await page.getByRole("heading", { name: "Connect your AI" }).waitFor();
      const candidate = page.locator('[data-candidate-kind="codex-cli"]');
      await candidate.getByRole("button", { name: "Test & use" }).click();

      const detect = await gateway.waitForRequest("openclaw.setup.detect");
      expect(detect.params).toEqual({});
      const activate = await gateway.waitForRequest("openclaw.setup.activate");
      expect(activate.params).toEqual({ kind: "codex-cli", modelRef: "openai/gpt-5" });

      await page.getByText("Your AI is ready").waitFor();
      await expect
        .poll(async () => page.locator(".model-setup__success").textContent())
        .toContain("openai/gpt-5 · 73 ms");
      await page.getByRole("button", { name: "Open Chat" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/custodian");
      expect(new URL(page.url()).searchParams.get("onboarding")).toBe("1");
      await page.getByRole("heading", { name: "OpenClaw", exact: true }).waitFor();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--onboarding");
      expect(await page.locator(".shell-nav").isVisible()).toBe(false);

      const chatRequest = await gateway.waitForRequest("openclaw.chat");
      expect(chatRequest.params).toMatchObject({
        sessionId: expect.stringMatching(/^control-ui-onboarding-/u),
        welcomeVariant: "onboarding",
      });
      await page.getByRole("button", { name: "Skip for now" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/chat");
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .not.toContain("shell--onboarding");
      const userTurns = (await gateway.getRequests("openclaw.chat")).filter((request) => {
        const params = request.params;
        return typeof params === "object" && params !== null && "message" in params;
      });
      expect(userTurns).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("completes device-code sign-in and re-detects the configured model", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const initialDetection = {
      candidates: [],
      manualProviders: [],
      authOptions: [
        {
          id: "provider-device-code",
          label: "Provider account",
          kind: "device-code",
          featured: true,
        },
      ],
      workspace: "/tmp/openclaw-e2e",
      setupComplete: false,
    };
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "openclaw.setup.detect",
        "openclaw.setup.auth.start",
        "wizard.next",
      ],
      methodResponses: {
        "openclaw.setup.detect": initialDetection,
        "openclaw.setup.auth.start": {
          sessionId: "device-code-session",
          done: false,
          status: "running",
        },
        "wizard.next": {
          sequence: [
            {
              done: false,
              status: "running",
              step: {
                id: "device-code",
                type: "note",
                title: "Authorize device",
                externalUrl: "https://example.com/device",
                deviceCode: { code: "ABCD-1234", expiresInMinutes: 14 },
              },
            },
            { done: true, status: "done" },
          ],
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/model-setup`);
      expect(response?.status()).toBe(200);
      await page.getByRole("button", { name: "Pair" }).click();

      const start = await gateway.waitForRequest("openclaw.setup.auth.start");
      expect(start.params).toMatchObject({ authChoice: "provider-device-code" });
      await page.getByText("ABCD-1234").waitFor();
      await page.getByText("Expires in 14 minutes").waitFor();
      const signInLink = page.getByRole("link", { name: "Open sign-in page" });
      await expect.poll(() => signInLink.getAttribute("href")).toBe("https://example.com/device");

      await gateway.setMethodResponse("openclaw.setup.detect", {
        ...initialDetection,
        authOptions: [],
        configuredModel: "provider/verified-model",
        setupComplete: true,
      });
      const detectCountBeforeCompletion = (await gateway.getRequests("openclaw.setup.detect"))
        .length;
      await page.getByRole("button", { name: "Continue" }).click();
      await expect.poll(async () => (await gateway.getRequests("wizard.next")).length).toBe(2);
      const wizardRequests = await gateway.getRequests("wizard.next");
      expect(wizardRequests[0]?.params).toMatchObject({ sessionId: expect.any(String) });
      expect(wizardRequests[1]?.params).toMatchObject({
        sessionId: expect.any(String),
        answer: { stepId: "device-code" },
      });
      await expect
        .poll(async () => (await gateway.getRequests("openclaw.setup.detect")).length)
        .toBe(detectCountBeforeCompletion + 1);
      await page.getByText("Your AI is ready").waitFor();
      await expect
        .poll(async () => page.locator(".model-setup__success").textContent())
        .toContain("provider/verified-model");
    } finally {
      await context.close();
    }
  });

  it("verifies the current model connection", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "openclaw.setup.detect",
        "openclaw.setup.verify",
      ],
      methodResponses: {
        "openclaw.setup.detect": {
          candidates: [],
          manualProviders: [],
          workspace: "/tmp/openclaw-e2e",
          configuredModel: "openai/gpt-5",
          setupComplete: true,
        },
        "openclaw.setup.verify": {
          ok: true,
          modelRef: "openai/gpt-5",
          latencyMs: 1234,
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/model-setup`);
      expect(response?.status()).toBe(200);
      await page.getByRole("button", { name: "Verify connection" }).click();
      const verify = await gateway.waitForRequest("openclaw.setup.verify");
      expect(verify.params).toEqual({});
      await page.getByText("Answered in 1234 ms").waitFor();
      const detectCountBeforeRefresh = (await gateway.getRequests("openclaw.setup.detect")).length;
      await page.getByRole("button", { name: "Check again" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("openclaw.setup.detect")).length)
        .toBe(detectCountBeforeRefresh + 1);
      await page.getByRole("button", { name: "Verify connection" }).waitFor();
      expect(await page.getByText("Answered in 1234 ms").count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
