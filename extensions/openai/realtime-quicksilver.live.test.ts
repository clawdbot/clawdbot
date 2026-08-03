import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readCodexCliCredentialsCached } from "openclaw/plugin-sdk/provider-auth";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import { resolveCodexAuthIdentity } from "./openai-chatgpt-auth-identity.js";
import { OpenAIQuicksilverVoiceBridge } from "./realtime-quicksilver-bridge.js";
import {
  createOpenAIQuicksilverBrowserSessionBroker,
  OPENAI_QUICKSILVER_OFFER_PATH,
  resolveOpenAIChatGptSubscriptionAuth,
} from "./realtime-quicksilver-session.js";
import {
  buildOpenAIQuicksilverSession,
  createOpenAIQuicksilverCall,
  openAIQuicksilverAuthHeaders,
  type OpenAIQuicksilverAuth,
} from "./realtime-quicksilver-wire.js";

const LIVE_ENABLED =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_GPT_LIVE === "1";
const describeLive = LIVE_ENABLED ? describe : describe.skip;
const LIVE_TIMEOUT_MS = 60_000;

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

async function createBrowserOffer(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    const peer = new RTCPeerConnection();
    peer.addTransceiver("audio", { direction: "sendrecv" });
    peer.createDataChannel("oai-events");
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const sdp = offer.sdp;
    if (!sdp) {
      peer.close();
      throw new Error("Chromium did not produce a GPT-Live SDP offer");
    }
    (globalThis as BrowserWithGptLivePeer).openclawGptLivePeer = peer;
    return sdp;
  });
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
    const profile = await resolveOpenAIChatGptSubscriptionAuth({});
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
    credential.accountId ?? resolveCodexAuthIdentity({ accessToken: credential.access }).accountId;
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
      const bridge = new OpenAIQuicksilverVoiceBridge({
        providerConfig: {},
        model: "gpt-live-1-codex",
        voice: "marin",
        instructions: "Keep this transport verification session silent.",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
        resolveAuth: async () => ({ type: "api-key", token: apiKey }),
        onAudio: () => {},
        onClearAudio: () => {},
      });
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
        const call = await createOpenAIQuicksilverCall({
          auth,
          requestIds,
          sdp: offerSdp,
          session: buildOpenAIQuicksilverSession({
            model: "gpt-live-1-codex",
            instructions: "Keep this transport verification session silent.",
            voice: "marin",
          }),
        });

        if (call.kind !== "gpt-live") {
          throw new Error("GPT-Live call unexpectedly used the GA realtime wire shape");
        }
        expect(call.status).toBe(201);
        expect(call.callId).toMatch(/^rtc_[\w-]+$/);
        expect(call.answerSdp).toMatch(/^v=0/m);
        await applyBrowserAnswer(page, call.answerSdp);

        const started = await waitForSidebandSessionStarted({
          url: call.sidebandUrl,
          headers: openAIQuicksilverAuthHeaders(auth, requestIds),
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
              { providerConfig: {}, model, voice: "marin" },
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
