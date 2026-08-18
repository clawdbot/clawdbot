// Control UI tests cover guided model setup against a mocked Gateway.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Model Setup mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
const localPrepareOptions = [
  {
    id: "ollama",
    brandId: "ollama",
    label: "Ollama",
    hint: "Connect to an Ollama server and select a cloud or local model",
    actionLabel: "Choose connection",
  },
  {
    id: "llama-cpp",
    brandId: "llama-cpp",
    label: "llama.cpp",
    hint: "Install a verified llama.cpp server and run a private GGUF model managed by OpenClaw",
    actionLabel: "Set up model",
  },
  {
    id: "lmstudio",
    brandId: "lmstudio",
    label: "LM Studio",
    hint: "Connect to a running LM Studio server and use an already loaded model",
    actionLabel: "Connect server",
    icon: "https://cdn.simpleicons.org/lmstudio",
    website: "https://lmstudio.ai/download",
  },
];

suite.define(() => {
  it("hands first-run model setup to the custodian in onboarding chrome", async () => {
    await suite.withPage(
      {
        ...(artifactDir
          ? { recordVideo: { dir: artifactDir, size: { width: 1280, height: 900 } } }
          : {}),
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
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
                  brandId: "openai",
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

        const response = await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
        expect(response?.status()).toBe(200);
        await page.getByRole("heading", { name: "Connect a verified AI model" }).waitFor();
        const candidate = page.locator('[data-candidate-kind="codex-cli"]');
        await expect.poll(() => candidate.locator('[data-provider-icon="codex"]').count()).toBe(1);
        await candidate.getByRole("button", { name: "Test & use" }).click();

        const detect = await gateway.waitForRequest("openclaw.setup.detect");
        expect(detect.params).toEqual({ agentId: "main" });
        const activate = await gateway.waitForRequest("openclaw.setup.activate");
        expect(activate.params).toEqual({
          kind: "codex-cli",
          agentId: "main",
          modelRef: "openai/gpt-5",
        });

        await page.getByRole("heading", { name: "Connection verified" }).waitFor();
        await expect
          .poll(async () => page.locator(".model-setup-success").textContent())
          .toContain("openai/gpt-5");
        await expect
          .poll(async () => page.locator(".model-setup-success").textContent())
          .toContain("Verified in 73 ms");
        await gateway.setMethodResponse("openclaw.setup.detect", {
          candidates: [],
          manualProviders: [{ id: "openai", label: "OpenAI" }],
          workspace: "/tmp/openclaw-e2e",
          setupComplete: true,
          configuredModel: "openai/gpt-5",
        });
        await page.getByRole("button", { name: "Stay in settings" }).click();
        await page.getByRole("button", { name: "Continue setup" }).waitFor();
        await page.reload();
        await page.getByRole("button", { name: "Continue setup" }).waitFor();
        if (artifactDir) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({
            path: path.join(artifactDir, "model-setup-durable-continuation.png"),
          });
        }
        await page.getByRole("button", { name: "Continue setup" }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/custodian");
        expect(new URL(page.url()).searchParams.get("onboarding")).toBe("1");
        // Onboarding chrome keeps only the header actions; no identity heading.
        await page.locator(".custodian__header--minimal").waitFor();
        await page.getByRole("button", { name: "Exit setup" }).waitFor();
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .toContain("shell--onboarding");
        expect(await page.locator(".shell-nav").isVisible()).toBe(false);
        if (artifactDir) {
          await page.screenshot({
            path: path.join(artifactDir, "custodian-onboarding-handoff.png"),
          });
        }

        const chatRequest = await gateway.waitForRequest("openclaw.chat");
        expect(chatRequest.params).toMatchObject({
          sessionId: expect.stringMatching(/^control-ui-onboarding-/u),
          welcomeVariant: "onboarding",
        });
        await page.getByRole("button", { name: "Skip for now" }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/chat/main");
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .not.toContain("shell--onboarding");
        const userTurns = (await gateway.getRequests("openclaw.chat")).filter((request) => {
          const params = request.params;
          return typeof params === "object" && params !== null && "message" in params;
        });
        expect(userTurns).toHaveLength(0);
      },
    );
  });

  it("completes device-code sign-in and re-detects the configured model", async () => {
    await suite.withPage(
      {
        ...(artifactDir
          ? { recordVideo: { dir: artifactDir, size: { width: 1280, height: 900 } } }
          : {}),
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const signInUrl = `https://example.com/device?${new URLSearchParams({
          client_id: "device-code-client",
          redirect_uri: "http://localhost:1455/auth/callback",
          response_type: "code",
          scope: "openid profile email offline_access",
          state: "state-1".repeat(16),
        })}`;
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
            "config.get": {
              config: {},
              sourceConfig: {},
              raw: "{}",
              hash: "config-hash-1",
              valid: true,
              issues: [],
            },
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
                    message: `Open this URL in your local browser:\n\n${signInUrl}`,
                    externalUrl: signInUrl,
                    deviceCode: { code: "ABCD-1234", expiresInMinutes: 14 },
                  },
                },
                { done: true, status: "done" },
              ],
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/model-setup`);
        expect(response?.status()).toBe(200);
        const configReadsBeforeStart = (await gateway.getRequests("config.get")).length;
        await gateway.deferNext("config.get");
        await page.getByRole("button", { name: "Pair" }).click();

        const start = await gateway.waitForRequest("openclaw.setup.auth.start");
        expect(start.params).toMatchObject({ authChoice: "provider-device-code" });
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBe(configReadsBeforeStart + 1);
        await page.getByText("ABCD-1234").waitFor();
        await page.getByText("Working…").waitFor();
        if (artifactDir) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({
            path: path.join(artifactDir, "model-setup-refresh-pending.png"),
          });
        }
        await gateway.rejectDeferred("config.get", {
          code: "UNAVAILABLE",
          message: "authoritative snapshot unavailable",
        });
        await expect.poll(() => page.getByText("Working…").count()).toBe(0);
        await page.getByText("Expires in 14 minutes").waitFor();
        await page
          .locator("openclaw-modal-dialog")
          .getByRole("alert")
          .filter({ hasText: "authoritative snapshot unavailable" })
          .waitFor();
        if (artifactDir) {
          await page.screenshot({
            path: path.join(artifactDir, "model-setup-refresh-warning.png"),
          });
        }
        const signInLink = page.getByRole("link", { name: "Open sign-in page" });
        await expect.poll(() => signInLink.getAttribute("href")).toBe(signInUrl);
        const wizardBody = page.locator(".model-setup-wizard__body");
        await expect
          .poll(() => wizardBody.evaluate((element) => element.scrollWidth <= element.clientWidth))
          .toBe(true);
        await page.setViewportSize({ height: 844, width: 390 });
        await expect
          .poll(() => wizardBody.evaluate((element) => element.scrollWidth <= element.clientWidth))
          .toBe(true);
        await page.getByRole("button", { name: "Continue" }).waitFor();
        await page.getByRole("button", { name: "Cancel" }).waitFor();

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
        await page.getByRole("heading", { name: "Connection verified" }).waitFor();
        await expect
          .poll(async () => page.locator(".model-setup-success").textContent())
          .toContain("provider/verified-model");
      },
    );
  });

  it("recovers Ollama setup in place after the local server starts", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const initialDetection = {
          candidates: [],
          manualProviders: [],
          prepareOptions: localPrepareOptions,
          recommendedInstalls: [
            {
              id: "ollama",
              brandId: "ollama",
              label: "Ollama",
              hint: "Run open models locally",
              website: "https://ollama.com/download",
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
            "openclaw.setup.activate",
            "openclaw.setup.prepare.start",
            "wizard.next",
          ],
          methodResponses: {
            "openclaw.setup.detect": initialDetection,
            "openclaw.setup.prepare.start": {
              sessionId: "ollama-prepare-session",
              done: false,
              status: "running",
            },
            "openclaw.setup.activate": {
              ok: true,
              modelRef: "ollama/qwen3:0.6b",
              latencyMs: 284,
              lines: ["Model ready"],
            },
            "wizard.next": {
              sequence: [
                {
                  done: false,
                  status: "running",
                  step: {
                    id: "ollama-mode",
                    type: "select",
                    message: "Ollama mode",
                    options: [
                      {
                        value: "cloud-local",
                        label: "Cloud + Local",
                        hint: "Route cloud and local models through your Ollama host",
                      },
                      { value: "cloud-only", label: "Cloud only", hint: "Hosted Ollama models" },
                      { value: "local-only", label: "Local only", hint: "Local models only" },
                    ],
                  },
                },
                {
                  done: false,
                  status: "running",
                  step: {
                    id: "ollama-base-url",
                    type: "text",
                    message: "Ollama base URL",
                    initialValue: "http://127.0.0.1:11434",
                  },
                },
                {
                  done: false,
                  status: "running",
                  step: {
                    id: "ollama-retry",
                    type: "note",
                    title: "Ollama",
                    message: [
                      "Ollama could not be reached at http://127.0.0.1:11434.",
                      "Start or restart the Ollama server for this address.",
                      "If Ollama is not installed on that machine, download it at https://ollama.com/download",
                      "",
                      "Continue when it is running. OpenClaw will retry this address.",
                    ].join("\n"),
                  },
                },
                {
                  done: false,
                  status: "running",
                  step: {
                    id: "ollama-retry-confirm",
                    type: "confirm",
                    message: "Retry this Ollama address now?",
                    initialValue: true,
                  },
                },
                {
                  done: true,
                  status: "done",
                  preparedModelRef: "ollama/qwen3:0.6b",
                },
              ],
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/model-setup`);
        expect(response?.status()).toBe(200);
        const localProviderIcons = page.locator(
          [
            '[data-prepare-choice="ollama"] [data-provider-icon="ollama"]',
            '[data-prepare-choice="llama-cpp"] [data-provider-icon="llamacpp"]',
            '[data-prepare-choice="lmstudio"] [data-provider-icon="lmstudio"]',
          ].join(","),
        );
        await expect.poll(() => localProviderIcons.count()).toBe(3);
        const localProviderIconColors = await localProviderIcons.evaluateAll((icons) =>
          icons.map((icon) => getComputedStyle(icon).color),
        );
        expect(localProviderIconColors).toHaveLength(3);
        expect(new Set(localProviderIconColors).size).toBe(1);
        await page
          .locator('[data-prepare-choice="ollama"]')
          .getByRole("button", { name: "Choose connection" })
          .click();

        const start = await gateway.waitForRequest("openclaw.setup.prepare.start");
        expect(start.params).toMatchObject({ authChoice: "ollama" });

        if (artifactDir) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "ollama-mode-select-desktop.png"),
          });
        }

        await page.getByRole("radio", { name: /Local only/u }).check();
        await page.getByRole("button", { name: "Continue" }).click();
        const baseUrl = page.getByLabel("Ollama base URL");
        await expect.poll(() => baseUrl.inputValue()).toBe("http://127.0.0.1:11434");

        if (artifactDir) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "ollama-host-desktop.png"),
          });
        }

        await page.getByRole("button", { name: "Submit" }).click();
        await page.getByText("Ollama could not be reached at http://127.0.0.1:11434.").waitFor();
        await page
          .getByText("Continue when it is running. OpenClaw will retry this address.")
          .waitFor();

        if (artifactDir) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "ollama-recovery-desktop.png"),
          });
        }

        await page.getByRole("button", { name: "Continue" }).click();
        await page.getByText("Retry this Ollama address now?").waitFor();

        await page.getByRole("button", { name: "Continue" }).click();
        await page.getByRole("heading", { name: "Connection verified" }).waitFor();
        await expect
          .poll(() => page.locator(".model-setup-success").textContent())
          .toContain("ollama/qwen3:0.6b");
        await expect
          .poll(() => page.locator(".model-setup-success").textContent())
          .toContain("Verified in 284 ms");
        await expect
          .poll(() => page.locator('.model-setup-success [data-provider-icon="ollama"]').count())
          .toBe(1);

        const activate = await gateway.waitForRequest("openclaw.setup.activate");
        expect(activate.params).toEqual({
          kind: "provider-auto:ollama",
          agentId: "main",
          modelRef: "ollama/qwen3:0.6b",
        });

        if (artifactDir) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "ollama-ready-desktop.png"),
          });
        }

        await gateway.setMethodResponse("openclaw.setup.detect", {
          ...initialDetection,
          candidates: [],
          configuredModel: "ollama/qwen3:0.6b",
          recommendedInstalls: [],
          setupComplete: true,
        });
        await page.getByRole("button", { name: "Stay in settings" }).click();
        const currentConnection = page.locator(".model-setup__current");
        await currentConnection.getByText("Ollama", { exact: true }).waitFor();
        await currentConnection.getByText("qwen3:0.6b", { exact: true }).waitFor();
        await expect
          .poll(() => currentConnection.locator('[data-provider-icon="ollama"]').count())
          .toBe(1);
        if (artifactDir) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "ollama-main-desktop.png"),
          });
        }

        const wizardRequests = await gateway.getRequests("wizard.next");
        expect(wizardRequests).toHaveLength(5);
        expect(wizardRequests[2]?.params).toMatchObject({
          answer: {
            stepId: "ollama-base-url",
            value: "http://127.0.0.1:11434",
          },
        });
        expect(wizardRequests[3]?.params).toMatchObject({
          answer: { stepId: "ollama-retry" },
        });
        expect(wizardRequests[4]?.params).toMatchObject({
          answer: { stepId: "ollama-retry-confirm", value: true },
        });
      },
    );
  });

  it("offers supported Google setup in an accessible provider picker", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "openclaw.setup.detect",
            "openclaw.setup.activate",
            "openclaw.setup.prepare.start",
          ],
          methodResponses: {
            "openclaw.setup.detect": {
              candidates: [],
              unavailableCandidates: [],
              manualProviders: [
                {
                  id: "qwen-cn",
                  brandId: "qwen",
                  groupLabel: "Qwen Cloud",
                  label: "Coding Plan API Key for China (subscription)",
                  hint: "Endpoint: coding.dashscope.aliyuncs.com",
                },
                {
                  id: "qwen-global",
                  brandId: "qwen",
                  groupLabel: "Qwen Cloud",
                  label: "Coding Plan API Key for Global/Intl (subscription)",
                  hint: "Endpoint: coding-intl.dashscope.aliyuncs.com",
                },
                {
                  id: "zai-cn",
                  brandId: "zai",
                  groupLabel: "Z.AI",
                  label: "Coding-Plan-CN",
                },
                {
                  id: "gemini-api-key",
                  brandId: "google",
                  groupLabel: "Google",
                  label: "Google AI Studio API key",
                  hint: "Supported API-key access from aistudio.google.com/apikey",
                },
              ],
              authOptions: [],
              workspace: "/tmp/openclaw-e2e",
              setupComplete: false,
            },
            "openclaw.setup.activate": {
              ok: true,
              modelRef: "qwen/qwen3-coder-plus",
              latencyMs: 412,
              lines: ["Model ready"],
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/model-setup`);
        expect(response?.status()).toBe(200);
        await page.getByRole("heading", { name: "Connect a verified AI model" }).waitFor();
        await expect.poll(() => page.getByText("Gemini CLI OAuth").count()).toBe(0);
        await expect.poll(() => page.getByText("Found, but needs attention").count()).toBe(0);

        const providerPicker = page.locator(".model-setup-provider-select");
        const providerTrigger = providerPicker.locator(".model-setup-provider-select__trigger");
        const manualProviderHasFocus = (providerId: string) =>
          page
            .locator(`[data-manual-provider="${providerId}"]`)
            .evaluate((element) => element === document.activeElement);
        const manualProviderMenuReady = () =>
          page
            .locator("[data-manual-provider]")
            .evaluateAll((options) => options.some((option) => option === document.activeElement));
        const providerHideMarker = "data-openclaw-test-after-hide";
        const armProviderHide = () =>
          providerPicker.evaluate((element, marker) => {
            element.removeAttribute(marker);
            element.addEventListener("wa-after-hide", () => element.setAttribute(marker, ""), {
              once: true,
            });
          }, providerHideMarker);
        const waitForProviderHide = async () => {
          await expect
            .poll(() =>
              providerPicker.evaluate(
                (element, marker) => element.hasAttribute(marker),
                providerHideMarker,
              ),
            )
            .toBe(true);
          await providerPicker.evaluate(
            (element, marker) => element.removeAttribute(marker),
            providerHideMarker,
          );
        };
        const providerIds = await page
          .locator("[data-manual-provider]")
          .evaluateAll((options) =>
            options
              .map((option) =>
                option instanceof HTMLElement ? option.dataset.manualProvider : null,
              )
              .filter((value): value is string => Boolean(value)),
          );
        const firstProviderId = providerIds[0]!;
        const lastProviderId = providerIds.at(-1)!;
        await providerTrigger.click();
        await expect
          .poll(() => providerPicker.evaluate((element) => element.hasAttribute("open")))
          .toBe(true);
        await expect
          .poll(() => page.locator('[data-manual-provider="qwen-cn"]').getAttribute("aria-label"))
          .toContain("Qwen Cloud");
        await expect
          .poll(() => page.locator('[data-manual-provider="zai-cn"]').getAttribute("aria-label"))
          .toContain("Z.AI");
        await expect
          .poll(() =>
            page.locator('[data-manual-provider="qwen-cn"] [data-provider-icon="alibaba"]').count(),
          )
          .toBe(1);

        if (artifactDir) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "provider-picker-desktop.png"),
          });
          await page.setViewportSize({ height: 844, width: 390 });
          await providerPicker.scrollIntoViewIfNeeded();
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, "provider-picker-mobile.png"),
          });
          await page.setViewportSize({ height: 1000, width: 1440 });
        }
        await armProviderHide();
        await page.keyboard.press("Escape");
        await waitForProviderHide();
        await expect
          .poll(() => providerPicker.evaluate((element) => element.hasAttribute("open")))
          .toBe(false);

        const accessValue = page.locator('.model-setup__manual input[type="password"]');
        await expect
          .poll(() => providerTrigger.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await page.keyboard.press("Enter");
        await expect
          .poll(() => providerPicker.evaluate((element) => element.hasAttribute("open")))
          .toBe(true);
        await expect.poll(manualProviderMenuReady).toBe(true);
        await page.keyboard.press("Home");
        await expect.poll(() => manualProviderHasFocus(firstProviderId)).toBe(true);
        await page.keyboard.press("End");
        await expect.poll(() => manualProviderHasFocus(lastProviderId)).toBe(true);
        await page.keyboard.press("Home");
        await expect.poll(() => manualProviderHasFocus(firstProviderId)).toBe(true);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await expect.poll(() => manualProviderHasFocus("zai-cn")).toBe(true);
        await armProviderHide();
        await page.keyboard.press("Enter");
        await waitForProviderHide();
        await expect.poll(() => providerTrigger.textContent()).toContain("Z.AI");
        await expect
          .poll(() => providerTrigger.evaluate((element) => element === document.activeElement))
          .toBe(true);

        await accessValue.fill("same-provider-secret");
        await providerTrigger.click();
        await expect.poll(manualProviderMenuReady).toBe(true);
        await armProviderHide();
        await page.locator('[data-manual-provider="zai-cn"]').click();
        await waitForProviderHide();
        await expect.poll(() => accessValue.inputValue()).toBe("same-provider-secret");
        await expect
          .poll(() => providerTrigger.evaluate((element) => element === document.activeElement))
          .toBe(true);

        await providerTrigger.click();
        await expect.poll(manualProviderMenuReady).toBe(true);
        await armProviderHide();
        await page.keyboard.press("Shift+Tab");
        await waitForProviderHide();
        await expect
          .poll(() => providerTrigger.evaluate((element) => element === document.activeElement))
          .toBe(true);

        await providerTrigger.click();
        await expect.poll(manualProviderMenuReady).toBe(true);
        await page.keyboard.press("Tab");
        await expect
          .poll(() => providerPicker.evaluate((element) => element.hasAttribute("open")))
          .toBe(false);
        await expect
          .poll(() => accessValue.evaluate((element) => element === document.activeElement))
          .toBe(true);

        await accessValue.fill("sk-old-provider-secret");
        await providerTrigger.click();
        await expect.poll(manualProviderMenuReady).toBe(true);
        await armProviderHide();
        await page.locator('[data-manual-provider="gemini-api-key"]').click();
        await waitForProviderHide();
        await expect.poll(() => providerTrigger.textContent()).toContain("Google");
        await expect.poll(() => providerTrigger.textContent()).toContain("AI Studio API key");
        await expect.poll(() => accessValue.inputValue()).toBe("");
        await expect
          .poll(() => providerTrigger.evaluate((element) => element === document.activeElement))
          .toBe(true);

        await providerTrigger.click();
        await armProviderHide();
        await page.locator('[data-manual-provider="qwen-cn"]').click();
        await waitForProviderHide();
        await expect
          .poll(() => providerPicker.evaluate((element) => element.hasAttribute("open")))
          .toBe(false);
        await expect.poll(() => providerTrigger.textContent()).toContain("Qwen Cloud");
        await accessValue.fill("qwen-test-secret");
        await expect.poll(() => accessValue.inputValue()).toBe("qwen-test-secret");
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        await page.getByRole("button", { name: "Connect & verify" }).click();
        const activate = await gateway.waitForRequest("openclaw.setup.activate");
        expect(activate.params).toEqual({
          kind: "api-key",
          agentId: "main",
          authChoice: "qwen-cn",
          apiKey: "qwen-test-secret",
        });
        await page.getByRole("heading", { name: "Connection verified" }).waitFor();
        await page.getByText("qwen/qwen3-coder-plus", { exact: true }).waitFor();

        if (artifactDir) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "success-desktop.png"),
          });
          await page.setViewportSize({ height: 844, width: 390 });
          await expect
            .poll(() =>
              page.locator("openclaw-modal-dialog.nav-drawer").evaluate((element) => {
                const dialog = element.shadowRoot
                  ?.querySelector("wa-dialog")
                  ?.shadowRoot?.querySelector("dialog");
                return dialog?.open ?? false;
              }),
            )
            .toBe(false);
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "success-mobile.png"),
          });
          await page.setViewportSize({ height: 1000, width: 1440 });
        }
        await expect
          .poll(() => page.locator(".model-setup-success").textContent())
          .toContain("Verified in 412 ms");

        const detectCountBeforeDismiss = (await gateway.getRequests("openclaw.setup.detect"))
          .length;
        await page.getByRole("button", { name: "Stay in settings" }).click();
        await expect
          .poll(async () => (await gateway.getRequests("openclaw.setup.detect")).length)
          .toBe(detectCountBeforeDismiss + 1);
        await providerTrigger.click();
        await expect.poll(manualProviderMenuReady).toBe(true);
        await armProviderHide();
        await page.locator('[data-manual-provider="gemini-api-key"]').click();
        await waitForProviderHide();
        await expect.poll(() => providerTrigger.textContent()).toContain("Google");
        await expect.poll(() => page.getByText("Gemini CLI OAuth").count()).toBe(0);
      },
    );
  });

  it("verifies the current model connection", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        ...(artifactDir
          ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
          : {}),
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "openclaw.setup.detect",
            "openclaw.setup.verify",
          ],
          methodResponses: {
            "openclaw.setup.detect": {
              candidates: [
                {
                  kind: "existing-model",
                  brandId: "openai",
                  label: "Current model",
                  detail: "openai/gpt-5 — already configured",
                  modelRef: "openai/gpt-5",
                  recommended: false,
                  credentials: true,
                },
                {
                  kind: "claude-cli",
                  brandId: "claude",
                  label: "Claude Code",
                  detail: "logged in",
                  modelRef: "claude-cli/claude-opus-5",
                  recommended: false,
                  credentials: true,
                },
              ],
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

        const response = await page.goto(`${suite.server.baseUrl}settings/model-setup`);
        expect(response?.status()).toBe(200);
        await expect
          .poll(() => page.locator('[data-candidate-kind="existing-model"]').count())
          .toBe(0);
        await expect.poll(() => page.locator('[data-candidate-kind="claude-cli"]').count()).toBe(1);
        if (artifactDir) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "configured-route-dedup-desktop.png"),
          });
          await page.setViewportSize({ height: 844, width: 390 });
          await expect
            .poll(() =>
              page.locator("openclaw-modal-dialog.nav-drawer").evaluate((element) => {
                const dialog = element.shadowRoot
                  ?.querySelector("wa-dialog")
                  ?.shadowRoot?.querySelector("dialog");
                return dialog?.open ?? false;
              }),
            )
            .toBe(false);
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "configured-route-dedup-mobile.png"),
          });
          await page.setViewportSize({ height: 900, width: 1280 });
        }
        await page.getByRole("button", { name: "Check model" }).click();
        const verify = await gateway.waitForRequest("openclaw.setup.verify");
        expect(verify.params).toEqual({ agentId: "main" });
        await page.getByText("Ready · 1234 ms").waitFor();
        const detectCountBeforeRefresh = (await gateway.getRequests("openclaw.setup.detect"))
          .length;
        const verifyCountBeforeRefresh = (await gateway.getRequests("openclaw.setup.verify"))
          .length;
        await page.getByRole("button", { name: "Check again" }).click();
        await expect
          .poll(async () => (await gateway.getRequests("openclaw.setup.verify")).length)
          .toBe(verifyCountBeforeRefresh + 1);
        expect((await gateway.getRequests("openclaw.setup.detect")).length).toBe(
          detectCountBeforeRefresh,
        );
        await page.getByRole("button", { name: "Check again" }).waitFor();
        await page.getByText("Ready · 1234 ms").waitFor();
      },
    );
  });
});
