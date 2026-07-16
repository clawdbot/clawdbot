// Control UI E2E tests cover browser Talk start and stop through a real page.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";
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

let server: ControlUiE2eServer;

async function installTalkBrowserFixtures(page: Page) {
  await page.addInitScript(() => {
    type InputProcessor = {
      onaudioprocess:
        | ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void)
        | null;
    };
    const state = {
      audioContextsClosed: 0,
      tracksStopped: 0,
      constraints: [] as unknown[],
      inputProcessor: null as InputProcessor | null,
      meterLevel: 0,
    };
    const track = { stop: () => (state.tracksStopped += 1) };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "built-in", label: "Built-in Microphone" },
          { kind: "audioinput", deviceId: "usb", label: "USB Audio Interface" },
          { kind: "videoinput", deviceId: "camera", label: "Camera" },
        ],
        getUserMedia: async (constraints: unknown) => {
          state.constraints.push(constraints);
          return { getTracks: () => [track] };
        },
      },
    });

    class MockAudioContext {
      readonly currentTime = 0;
      readonly destination = {};
      readonly sampleRate: number;

      constructor(options?: { sampleRate?: number }) {
        this.sampleRate = options?.sampleRate ?? 24_000;
      }

      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }

      createGain() {
        return { connect() {}, disconnect() {}, gain: { value: 1 } };
      }

      createScriptProcessor() {
        const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
        state.inputProcessor = processor;
        return processor;
      }

      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          disconnect() {},
          getFloatTimeDomainData(samples: Float32Array) {
            samples.fill(state.meterLevel);
          },
        };
      }

      async close() {
        state.audioContextsClosed += 1;
      }
    }

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: MockAudioContext,
    });
    Object.defineProperty(window, "openclawTalkE2eState", {
      configurable: true,
      value: state,
    });
  });
}

async function captureComposerProof(page: Page, fileName: string) {
  const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "voice-controls");
  await mkdir(artifactDir, { recursive: true });
  await page
    .locator(".agent-chat__composer-shell")
    .screenshot({ path: path.join(artifactDir, fileName) });
}

async function installBlockedMicrophoneFixture(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [],
        getUserMedia: async () => {
          throw new DOMException("Permission denied", "NotAllowedError");
        },
      },
    });
  });
}

describeControlUiE2e("Control UI browser Talk", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("starts a provider WebSocket session and stops browser audio resources", async () => {
    const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "talk.client.create": {
          provider: "google",
          transport: "provider-websocket",
          protocol: "google-live-bidi",
          clientSecret: "auth_tokens/browser-talk-e2e",
          websocketUrl:
            "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
          audio: {
            inputEncoding: "pcm16",
            inputSampleRateHz: 16_000,
            outputEncoding: "pcm16",
            outputSampleRateHz: 24_000,
          },
        },
      },
    });
    await installTalkBrowserFixtures(page);

    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      // The microphone picker lives on the Settings appearance page; the
      // selection persists and applies to talk sessions started from chat.
      await page.goto(`${server.baseUrl}settings/appearance`);
      const microphoneSelect = page.locator("[data-settings-microphone]");
      await expect
        .poll(async () =>
          (await microphoneSelect.locator("option").allTextContents()).map((label) => label.trim()),
        )
        .toEqual(["System default", "Built-in Microphone", "USB Audio Interface"]);
      await microphoneSelect.selectOption("usb");
      await page.goto(`${server.baseUrl}chat`);
      await page.setViewportSize({ width: 320, height: 720 });
      await page.getByRole("button", { name: "Start voice input" }).click();

      const createRequest = await gateway.waitForRequest("talk.client.create");
      expect(createRequest.params).toMatchObject({ sessionKey: "main" });
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as Window & {
                  openclawTalkE2eState?: { constraints: unknown[] };
                }
              ).openclawTalkE2eState?.constraints,
          ),
        )
        .toEqual([
          {
            audio: {
              autoGainControl: true,
              deviceId: { exact: "usb" },
              echoCancellation: true,
              noiseSuppression: true,
            },
          },
        ]);
      await expect
        .poll(async () =>
          (await gateway.getSocketUrls()).filter((url) => url.includes("BidiGenerateContent")),
        )
        .toEqual([
          "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fbrowser-talk-e2e",
        ]);

      await expect
        .poll(() => page.locator('.agent-chat__voice-activity[data-status="connecting"]').count())
        .toBe(1);
      // The level meter renders inside the stop-voice pill button, not as a
      // separate floating row above the composer.
      await expect
        .poll(() =>
          page.locator('button[aria-label="Stop voice input"] .agent-chat__voice-activity').count(),
        )
        .toBe(1);
      // Phone widths keep the pill wide enough for the 7-bar meter instead of
      // collapsing it to the generic 44px square control size.
      const pillBox = await page.getByRole("button", { name: "Stop voice input" }).boundingBox();
      expect(pillBox?.width ?? 0).toBeGreaterThanOrEqual(60);
      await expect
        .poll(() =>
          page
            .locator(".agent-chat__voice-activity-bar")
            .first()
            .evaluate((element) => {
              return getComputedStyle(element).animationName;
            }),
        )
        .toBe("none");
      const connectingReducedMotionTransform = await page
        .locator(".agent-chat__voice-activity-bar")
        .first()
        .evaluate((element) => getComputedStyle(element).transform);

      await gateway.deliverLatest({ setupComplete: {} });
      await expect
        .poll(() => page.locator('.agent-chat__voice-activity[data-status="listening"]').count())
        .toBe(1);
      await expect.poll(() => page.locator(".agent-chat__talk-status-text").count()).toBe(0);
      await expect
        .poll(() => page.locator('[role="status"].agent-chat__voice-status').textContent())
        .toBe("Listening...");
      const reducedMotionTransform = await page
        .locator(".agent-chat__voice-activity-bar")
        .first()
        .evaluate((element) => getComputedStyle(element).transform);
      expect(reducedMotionTransform).not.toBe(connectingReducedMotionTransform);

      await page.evaluate(() => {
        const state = (
          window as Window & {
            openclawTalkE2eState?: {
              inputProcessor?: {
                onaudioprocess?: (event: {
                  inputBuffer: { getChannelData: () => Float32Array };
                }) => void;
              };
              meterLevel?: number;
            };
          }
        ).openclawTalkE2eState;
        if (state) {
          state.meterLevel = 0.25;
        }
        state?.inputProcessor?.onaudioprocess?.({
          inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.25) },
        });
      });
      await expect
        .poll(async () =>
          Number(await page.locator(".agent-chat__voice-activity").getAttribute("data-level")),
        )
        .toBeGreaterThan(0);
      await expect
        .poll(() =>
          page
            .locator(".agent-chat__voice-activity-bar")
            .first()
            .evaluate((element) => getComputedStyle(element).transform),
        )
        .toBe(reducedMotionTransform);

      await page.getByRole("button", { name: "Stop voice input" }).click();
      await expect
        .poll(() => page.getByRole("button", { name: "Start voice input" }).isVisible())
        .toBe(true);
      await expect.poll(() => page.locator(".agent-chat__voice-activity").count()).toBe(0);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const state = (
              window as Window & {
                openclawTalkE2eState?: { audioContextsClosed: number; tracksStopped: number };
              }
            ).openclawTalkE2eState;
            return state
              ? {
                  audioContextsClosed: state.audioContextsClosed,
                  tracksStopped: state.tracksStopped,
                }
              : null;
          }),
        )
        .toEqual({ audioContextsClosed: 2, tracksStopped: 1 });

      await gateway.deliverLatest({ setupComplete: {} });
      await expect
        .poll(() => page.getByRole("button", { name: "Start voice input" }).isVisible())
        .toBe(true);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it("keeps stop-voice and stop-run controls visually distinct while both are active", async () => {
    const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.send"],
      methodResponses: {
        "talk.client.create": {
          provider: "google",
          transport: "provider-websocket",
          protocol: "google-live-bidi",
          // Fake harness token, assembled so secret scanners do not flag it.
          clientSecret: ["auth_tokens", "browser-talk-e2e"].join("/"),
          websocketUrl:
            "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
          audio: {
            inputEncoding: "pcm16",
            inputSampleRateHz: 16_000,
            outputEncoding: "pcm16",
            outputSampleRateHz: 24_000,
          },
        },
      },
    });
    await installTalkBrowserFixtures(page);

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.setViewportSize({ width: 1366, height: 900 });

      await page.getByRole("button", { name: "Start voice input" }).click();
      await gateway.waitForRequest("talk.client.create");
      await gateway.deliverLatest({ setupComplete: {} });
      const stopVoice = page.getByRole("button", { name: "Stop voice input" });
      await expect.poll(() => stopVoice.isVisible()).toBe(true);
      await page.evaluate(() => {
        const state = (
          window as Window & {
            openclawTalkE2eState?: {
              inputProcessor?: {
                onaudioprocess?: (event: {
                  inputBuffer: { getChannelData: () => Float32Array };
                }) => void;
              };
              meterLevel?: number;
            };
          }
        ).openclawTalkE2eState;
        if (state) {
          state.meterLevel = 0.25;
        }
        state?.inputProcessor?.onaudioprocess?.({
          inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.25) },
        });
      });
      await expect
        .poll(async () =>
          Number(await page.locator(".agent-chat__voice-activity").getAttribute("data-level")),
        )
        .toBeGreaterThan(0);
      await captureComposerProof(page, "01-voice-live-listening.png");

      // Enter-sends while voice is active; the deferred chat.send keeps the
      // run abortable so both stop controls render side by side.
      const textarea = page.locator(".agent-chat__input textarea");
      await textarea.fill("Keep working on the report");
      await textarea.press("Enter");
      const sendRequest = await gateway.waitForRequest("chat.send");
      const runId =
        typeof sendRequest.params === "object" &&
        sendRequest.params !== null &&
        "idempotencyKey" in sendRequest.params
          ? String(sendRequest.params.idempotencyKey)
          : "";
      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      await gateway.emitGatewayEvent("chat", {
        deltaText: "Working on it.",
        message: {
          content: [{ text: "Working on it.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });
      const stopRun = page.getByRole("button", { name: "Stop generating" });
      await expect.poll(() => stopRun.isVisible()).toBe(true);
      await expect.poll(() => stopVoice.isVisible()).toBe(true);

      expect(
        await stopVoice.evaluate((node) => node.classList.contains("chat-send-btn--voice-live")),
      ).toBe(true);
      expect(
        await stopVoice.evaluate((node) => node.classList.contains("chat-send-btn--stop")),
      ).toBe(false);
      expect(await stopVoice.locator(".agent-chat__voice-activity").count()).toBe(1);
      expect(await page.locator(".chat-send-btn--stop").count()).toBe(1);
      await captureComposerProof(page, "02-voice-plus-run-stop.png");

      await page.emulateMedia({ colorScheme: "dark" });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.themeMode))
        .toBe("dark");
      await captureComposerProof(page, "03-voice-plus-run-stop-dark.png");

      await stopVoice.hover();
      await captureComposerProof(page, "04-voice-live-hover-stop-glyph.png");

      // Stopping voice must leave the run (and its stop control) untouched.
      await stopVoice.click();
      await expect.poll(() => stopVoice.count()).toBe(0);
      await expect.poll(() => stopRun.isVisible()).toBe(true);
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it("renders streamed relay assistant transcript deltas as readable text", async () => {
    const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    const relaySessionId = "relay-e2e-transcript";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "talk.client.create": {
          provider: "openai",
          transport: "gateway-relay",
          relaySessionId,
          audio: {
            inputEncoding: "pcm16",
            inputSampleRateHz: 16_000,
            outputEncoding: "pcm16",
            outputSampleRateHz: 24_000,
          },
        },
        "talk.session.appendAudio": {},
        "talk.session.close": {},
      },
    });
    await installTalkBrowserFixtures(page);

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.setViewportSize({ width: 1366, height: 900 });
      await page.getByRole("button", { name: "Start voice input" }).click();
      await gateway.waitForRequest("talk.client.create");
      // The request is recorded before its mock response is delivered. Wait for
      // microphone setup before probing relay readiness below.
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as Window & {
                  openclawTalkE2eState?: { constraints: unknown[] };
                }
              ).openclawTalkE2eState?.constraints.length,
          ),
        )
        .toBe(1);
      await gateway.emitGatewayEvent("talk.event", { relaySessionId, type: "ready" });
      await expect
        .poll(() => page.locator('.agent-chat__voice-activity[data-status="listening"]').count())
        .toBe(1);
      await gateway.emitGatewayEvent("talk.event", {
        relaySessionId,
        type: "transcript",
        role: "user",
        text: "Hey, what model are you using?",
        final: true,
      });
      await expect
        .poll(() =>
          page.locator(".agent-chat__voice-turn--user .agent-chat__voice-turn-text").textContent(),
        )
        .toBe("Hey, what model are you using?");
      // Assistant audio transcripts stream as verbatim fragments that can split
      // words ("I","'m"," Chat","G","PT"); regression coverage for #102556 where
      // the merge injected spaces mid-word and the turn collapsed while streaming.
      const assistantText =
        "I'm ChatGPT, a conversational AI model designed to help answer questions, brainstorm ideas, and chat about pretty much anything you want to talk about today.";
      for (const char of assistantText) {
        await gateway.emitGatewayEvent("talk.event", {
          relaySessionId,
          type: "transcript",
          role: "assistant",
          text: char,
          final: false,
        });
      }

      const assistantTurnText = page.locator(
        ".agent-chat__voice-turn--assistant .agent-chat__voice-turn-text",
      );
      await expect.poll(() => assistantTurnText.textContent()).toBe(assistantText);

      const turnBounds = await page.locator(".agent-chat__voice-turn--assistant").boundingBox();
      expect(turnBounds).not.toBeNull();
      // A collapsed turn renders one character per line (tall, sliver-wide box).
      expect(turnBounds?.width ?? 0).toBeGreaterThanOrEqual(500);
      expect(turnBounds?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(120);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it("keeps blocked microphone guidance readable in a narrow viewport", async () => {
    const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext();
    const page = await context.newPage();
    await installMockGateway(page);
    await installBlockedMicrophoneFixture(page);

    try {
      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto(`${server.baseUrl}settings/appearance`);
      await page.getByRole("button", { name: "Refresh: Microphone input" }).click();

      const permissionAlert = page.getByRole("alert");
      await expect.poll(() => permissionAlert.isVisible()).toBe(true);
      const alertBounds = await permissionAlert.boundingBox();
      expect(alertBounds).not.toBeNull();
      expect(alertBounds?.x ?? 0).toBeGreaterThanOrEqual(0);
      expect((alertBounds?.x ?? 0) + (alertBounds?.width ?? 0)).toBeLessThanOrEqual(320);
      await expect
        .poll(() => permissionAlert.textContent())
        .toContain("Microphone access is blocked.");
    } finally {
      await context.close();
      await browser.close();
    }
  });
});
