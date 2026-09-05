import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  readCodexCliCredentialsCached,
  resolveOpenAICodexAuthIdentity,
} from "openclaw/plugin-sdk/provider-auth";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "openclaw/plugin-sdk/realtime-voice";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import { resolveOpenAIChatGptSubscriptionAuth } from "./realtime-auth.js";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverVoiceBridge } from "./realtime-quicksilver-bridge.js";
import {
  createOpenAIQuicksilverBrowserSessionBroker,
  OPENAI_QUICKSILVER_OFFER_PATH,
} from "./realtime-quicksilver-session.js";
import {
  buildOpenAIQuicksilverSession,
  createOpenAIQuicksilverCall,
  openAIQuicksilverAuthHeaders,
  type OpenAIQuicksilverAuth,
} from "./realtime-quicksilver-wire.js";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";
import { OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL } from "./realtime-voice-session-policy.js";

const LIVE_ENABLED =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_GPT_LIVE === "1";
const describeLive = LIVE_ENABLED ? describe : describe.skip;
const LIVE_TIMEOUT_MS = 60_000;
const LIVE_MILESTONE_TIMEOUT_MS = 30_000;

type BrowserWithGptLivePeer = typeof globalThis & {
  openclawGptLivePeer?: RTCPeerConnection;
};

function decodeTextFrame(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

async function createBrowserOffer(page: Page, includeDataChannel = true): Promise<string> {
  return await page.evaluate(async (shouldCreateDataChannel) => {
    const peer = new RTCPeerConnection();
    peer.addTransceiver("audio", { direction: "sendrecv" });
    if (shouldCreateDataChannel) {
      peer.createDataChannel("oai-events");
    }
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const sdp = offer.sdp;
    if (!sdp) {
      peer.close();
      throw new Error("Chromium did not produce a GPT-Live SDP offer");
    }
    (globalThis as BrowserWithGptLivePeer).openclawGptLivePeer = peer;
    return sdp;
  }, includeDataChannel);
}

async function applyBrowserAnswer(page: Page, sdp: string): Promise<void> {
  await page.evaluate(async (answerSdp) => {
    const peer = (globalThis as BrowserWithGptLivePeer).openclawGptLivePeer;
    if (!peer) {
      throw new Error("GPT-Live browser peer is unavailable");
    }
    await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }, sdp);
}

async function waitForLiveMilestone(
  milestone: Promise<void>,
  label: string,
  eventClasses: readonly string[],
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      milestone,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`GA sideband ${label} timed out; eventClasses=${eventClasses.join(",")}`),
            ),
          LIVE_MILESTONE_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function closeBrowserPeer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = globalThis as BrowserWithGptLivePeer;
    target.openclawGptLivePeer?.close();
    delete target.openclawGptLivePeer;
  });
}

async function waitForSidebandSessionStarted(params: {
  url: string;
  headers: Record<string, string>;
}): Promise<{ socket: WebSocket; sessionId: string }> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(params.url, { headers: params.headers });
    const timeout = setTimeout(() => {
      socket.close(1000, "session-start timeout");
      reject(new Error("GPT-Live sideband did not emit session.started"));
    }, 15_000);
    const finish = (result: { socket: WebSocket; sessionId: string } | Error) => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(decodeTextFrame(data));
      } catch {
        return;
      }
      if (!decoded || typeof decoded !== "object") {
        return;
      }
      const event = decoded as { type?: unknown; session?: { id?: unknown } };
      if (event.type === "session.started" && typeof event.session?.id === "string") {
        finish({ socket, sessionId: event.session.id });
      }
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("GPT-Live sideband closed before session.started"));
    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function sendSessionClose(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify({ type: "session.close" }), (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  socket.close(1000, "test complete");
}

async function resolveLiveOAuthProfile(): Promise<
  Extract<OpenAIQuicksilverAuth, { type: "oauth" }> | undefined
> {
  try {
    const profile = await resolveOpenAIChatGptSubscriptionAuth({}, openAIRealtimeHost);
    if (profile) {
      return profile;
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AuthProfileMigrationRequiredError") {
      throw error;
    }
  }
  // The live probe may run while an older local OpenClaw profile awaits Doctor.
  // Codex CLI OAuth proves the same bearer/account wire without changing runtime fallback rules.
  const credential = readCodexCliCredentialsCached({ allowKeychainPrompt: false, ttlMs: 0 });
  if (!credential) {
    return undefined;
  }
  const accountId =
    credential.accountId ?? resolveOpenAICodexAuthIdentity({ access: credential.access }).accountId;
  return accountId ? { type: "oauth", token: credential.access, accountId } : undefined;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Live realtime broker did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describeLive("GPT-Live Platform WebSocket", () => {
  it(
    "opens a Frameless Bidi session without a browser or WebRTC",
    async ({ skip }) => {
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        skip("No OpenAI Platform API key is available");
        return;
      }
      const bridge = new OpenAIQuicksilverVoiceBridge(
        {
          providerConfig: {},
          model: "gpt-live-1-codex",
          voice: "spruce",
          instructions: "Keep this transport verification session silent.",
          audioFormat: { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
          resolveAuth: async () => ({ type: "api-key", token: apiKey }),
          onAudio: () => {},
          onClearAudio: () => {},
        },
        openAIRealtimeHost,
      );
      try {
        await bridge.connect();
        expect(bridge.isConnected()).toBe(true);
      } finally {
        bridge.close();
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

describeLive("OpenAI GA Gateway-controlled WebRTC", () => {
  it(
    "brokers audio-only SDP, attaches the Platform sideband, and completes one tool response",
    async ({ skip }) => {
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        skip("No OpenAI Platform API key is available");
        return;
      }
      const realtime = createOpenAIQuicksilverBrowserSessionBroker({
        getConfig: () => ({}),
        logger: { debug: () => undefined, warn: () => undefined },
      });
      const provider = buildOpenAIRealtimeVoiceProvider({
        quicksilverBrowserSessionBroker: realtime.broker,
      });
      const server = createServer((req, res) => {
        if (req.url === "/") {
          res.statusCode = 200;
          res.end("<!doctype html><title>OpenClaw GA sideband proof</title>");
          return;
        }
        if (req.url === OPENAI_QUICKSILVER_OFFER_PATH) {
          void realtime.handler(req, res);
          return;
        }
        res.statusCode = 404;
        res.end("Not found");
      });
      const baseUrl = await listen(server);
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--use-fake-device-for-media-stream"],
      });
      const page = await browser.newPage();
      let controlBridge: ReturnType<typeof provider.createBridge> | undefined;
      let reservation:
        | Awaited<ReturnType<NonNullable<typeof provider.createBrowserSession>>>
        | undefined;
      let resolveTool!: () => void;
      let resolveFunctionOutputAdded!: () => void;
      let resolveFunctionOutputDone!: () => void;
      let resolveResponse!: () => void;
      let rejectFunctionOutputAdded!: (error: Error) => void;
      let responseDoneCount = 0;
      let responseCreateCount = 0;
      let responseCreateCountAtToolCall = 0;
      let sessionPolicyReady = false;
      const eventClasses: string[] = [];
      const toolObserved = new Promise<void>((resolve) => {
        resolveTool = resolve;
      });
      const functionOutputAdded = new Promise<void>((resolve, reject) => {
        resolveFunctionOutputAdded = resolve;
        rejectFunctionOutputAdded = reject;
      });
      const functionOutputDone = new Promise<void>((resolve) => {
        resolveFunctionOutputDone = resolve;
      });
      const responseObserved = new Promise<void>((resolve) => {
        resolveResponse = resolve;
      });
      try {
        await page.goto(baseUrl);
        reservation = await provider.createBrowserSession!({
          providerConfig: { apiKey },
          model: "gpt-realtime-2.1",
          voice: "marin",
          instructions:
            "When the user asks for a check, call openclaw_agent_consult exactly once, then speak its result.",
          tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL],
          gatewayControl: {
            bindBridge: (bridge) => {
              controlBridge = bridge;
            },
            onToolCall: (event) => {
              responseCreateCountAtToolCall = responseCreateCount;
              resolveTool();
              try {
                void Promise.resolve(
                  controlBridge?.submitToolResult(event.callId, {
                    result: "OpenClaw GA sideband live proof passed.",
                  }),
                ).catch((error: unknown) =>
                  rejectFunctionOutputAdded(
                    error instanceof Error ? error : new Error("function output submission failed"),
                  ),
                );
              } catch (error) {
                rejectFunctionOutputAdded(
                  error instanceof Error ? error : new Error("function output submission failed"),
                );
              }
            },
            onEvent: (event) => {
              if (eventClasses.length < 64) {
                eventClasses.push(`${event.direction}:${event.type}`);
              }
              if (
                event.direction === "server" &&
                event.type === "session.updated" &&
                event.detail === "tools=1 toolChoice=auto"
              ) {
                sessionPolicyReady = true;
              }
              if (event.direction === "client" && event.type === "response.create") {
                responseCreateCount += 1;
              }
              if (
                event.direction === "server" &&
                event.type === "conversation.item.added" &&
                event.detail === "itemType=function_call_output"
              ) {
                resolveFunctionOutputAdded();
              }
              if (
                event.direction === "server" &&
                event.type === "conversation.item.done" &&
                event.detail === "itemType=function_call_output"
              ) {
                resolveFunctionOutputDone();
              }
              if (event.direction === "server" && event.type === "response.done") {
                responseDoneCount += 1;
                if (responseDoneCount === 2) {
                  resolveResponse();
                }
              }
            },
          },
        });
        if (reservation.transport !== "webrtc" || !reservation.offerUrl) {
          throw new Error("GA Gateway control did not return a WebRTC broker reservation");
        }
        const offerSdp = await createBrowserOffer(page, false);
        expect(offerSdp).not.toMatch(/^m=application /m);
        const brokerResponse = await page.evaluate(
          async ({ offerUrl, token, sdp }) => {
            const response = await fetch(offerUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/sdp" },
              body: sdp,
            });
            return { status: response.status, answerSdp: await response.text() };
          },
          {
            offerUrl: `${baseUrl}${reservation.offerUrl}`,
            token: reservation.clientSecret,
            sdp: offerSdp,
          },
        );
        expect(brokerResponse.status).toBe(201);
        await applyBrowserAnswer(page, brokerResponse.answerSdp);
        expect(sessionPolicyReady).toBe(true);
        controlBridge?.sendUserMessage?.("Run the requested OpenClaw verification.", {
          toolChoice: { type: "function", name: "openclaw_agent_consult" },
        });
        await waitForLiveMilestone(toolObserved, "tool call", eventClasses);
        await waitForLiveMilestone(functionOutputAdded, "function output added", eventClasses);
        await waitForLiveMilestone(functionOutputDone, "function output done", eventClasses);
        await waitForLiveMilestone(responseObserved, "terminal response", eventClasses);
        expect(responseCreateCount - responseCreateCountAtToolCall).toBe(1);
        expect(responseDoneCount).toBe(2);
      } finally {
        if (reservation) {
          await Promise.resolve(realtime.broker.cancelBrowserSession(reservation)).catch(
            () => undefined,
          );
        }
        await closeBrowserPeer(page).catch(() => undefined);
        await browser.close();
        await realtime.cleanup();
        await closeServer(server);
        expect(realtime.getSessionCounts()).toEqual({
          pending: 0,
          inFlight: 0,
          active: 0,
          reservations: 0,
        });
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

describeLive("OpenAI OAuth WebRTC", () => {
  it(
    "creates a call and joins the authenticated sideband",
    async ({ skip }) => {
      const auth = await resolveLiveOAuthProfile();
      if (!auth) {
        skip("No ChatGPT OAuth profile is available");
        return;
      }

      const { chromium } = await import("playwright");
      const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--use-fake-device-for-media-stream"],
      });
      const page = await browser.newPage();
      let sideband: WebSocket | undefined;
      try {
        const offerSdp = await createBrowserOffer(page);
        const requestIds = {
          realtimeSessionId: randomUUID(),
          sessionId: randomUUID(),
          threadId: randomUUID(),
        };
        const call = await createOpenAIQuicksilverCall(
          {
            auth,
            requestIds,
            sdp: offerSdp,
            session: buildOpenAIQuicksilverSession({
              model: "gpt-live-1-codex",
              instructions: "Keep this transport verification session silent.",
              voice: "spruce",
            }),
          },
          openAIRealtimeHost,
        );

        if (call.kind !== "gpt-live") {
          throw new Error("GPT-Live call unexpectedly used the GA realtime wire shape");
        }
        expect(call.status).toBe(201);
        expect(call.callId).toMatch(/^rtc_[\w-]+$/);
        expect(call.answerSdp).toMatch(/^v=0/m);
        await applyBrowserAnswer(page, call.answerSdp);

        const started = await waitForSidebandSessionStarted({
          url: call.sidebandUrl,
          headers: openAIQuicksilverAuthHeaders(auth, requestIds, openAIRealtimeHost),
        });
        sideband = started.socket;
        expect(started.sessionId).toBe(call.callId);
        await sendSessionClose(sideband);
        sideband = undefined;
      } finally {
        sideband?.close(1000, "test cleanup");
        await closeBrowserPeer(page).catch(() => undefined);
        await browser.close();
      }
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "creates all GA realtime models through the single-use OAuth broker",
    async ({ skip }) => {
      const auth = await resolveLiveOAuthProfile();
      if (!auth) {
        skip("No OpenClaw ChatGPT OAuth profile is available");
        return;
      }

      const realtime = createOpenAIQuicksilverBrowserSessionBroker({
        getConfig: () => ({}),
        logger: { debug: () => undefined, warn: () => undefined },
      });
      const server = createServer((req, res) => {
        if (req.url === "/") {
          res.statusCode = 200;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end("<!doctype html><title>OpenClaw realtime live proof</title>");
          return;
        }
        if (req.url === OPENAI_QUICKSILVER_OFFER_PATH) {
          void realtime.handler(req, res);
          return;
        }
        res.statusCode = 404;
        res.end("Not found");
      });
      const baseUrl = await listen(server);
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--use-fake-device-for-media-stream"],
      });
      const page = await browser.newPage();
      try {
        await page.goto(baseUrl);
        for (const model of ["gpt-realtime-2.1", "gpt-realtime-2.1-mini", "gpt-realtime-2"]) {
          try {
            const reservation = await realtime.broker.createBrowserSession(
              {
                providerConfig: {},
                model,
                voice: "marin",
                gaSession: {
                  type: "realtime",
                  model,
                  instructions: "Keep this transport verification session silent.",
                  audio: {
                    input: {
                      noise_reduction: { type: "near_field" },
                      turn_detection: {
                        type: "server_vad",
                        create_response: true,
                        interrupt_response: true,
                      },
                      transcription: { model: OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL },
                    },
                    output: { voice: "marin" },
                  },
                  tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL],
                  tool_choice: "auto",
                },
              },
              auth,
            );
            if (reservation.transport !== "webrtc") {
              throw new Error("GA realtime broker did not return a WebRTC reservation");
            }
            if (!reservation.offerUrl) {
              throw new Error("GA realtime broker did not return an offer URL");
            }
            const offerSdp = await createBrowserOffer(page);
            const brokerResponse = await page.evaluate(
              async ({ offerUrl, token, sdp }) => {
                const response = await fetch(offerUrl, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/sdp",
                  },
                  body: sdp,
                });
                return { status: response.status, answerSdp: await response.text() };
              },
              {
                offerUrl: `${baseUrl}${reservation.offerUrl}`,
                token: reservation.clientSecret,
                sdp: offerSdp,
              },
            );

            expect(brokerResponse, model).toEqual({
              status: 201,
              answerSdp: expect.stringMatching(/^v=0/m),
            });
            await applyBrowserAnswer(page, brokerResponse.answerSdp);
            await expect(
              page.evaluate(
                () =>
                  (globalThis as BrowserWithGptLivePeer).openclawGptLivePeer?.remoteDescription
                    ?.type,
              ),
              model,
            ).resolves.toBe("answer");
          } finally {
            await closeBrowserPeer(page).catch(() => undefined);
          }
        }
      } finally {
        await browser.close();
        await realtime.cleanup();
        await closeServer(server);
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
