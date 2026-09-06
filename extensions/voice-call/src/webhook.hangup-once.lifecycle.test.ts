// Voice Call tests cover webhook.hangup once.lifecycle plugin behavior.
import crypto from "node:crypto";
import fs from "node:fs";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema, type VoiceCallConfig } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createTestStorePath,
  FakeProvider,
  finalizeTestManagerCalls,
} from "./manager.test-harness.js";
import { TwilioProvider } from "./providers/twilio.js";
import { getOptionalVoiceCallStateRuntime, setVoiceCallStateRuntime } from "./runtime-state.js";
import type { WebhookContext, WebhookParseOptions } from "./types.js";
import { VoiceCallWebhookServer } from "./webhook.js";

function installStateRuntime(): void {
  setVoiceCallStateRuntime({
    state: {
      resolveStateDir: () => "",
      openKeyedStore: (() => {
        throw new Error("openKeyedStore is not used by voice-call webhook lifecycle tests");
      }) as never,
      openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
        createPluginStateSyncKeyedStoreForTests("voice-call", options),
      openChannelIngressQueue: (() => {
        throw new Error(
          "openChannelIngressQueue is not used by voice-call webhook lifecycle tests",
        );
      }) as never,
      openChannelIngressDrain: (() => {
        throw new Error(
          "openChannelIngressDrain is not used by voice-call webhook lifecycle tests",
        );
      }) as never,
    },
  });
}

const createConfig = (overrides: Partial<VoiceCallConfig> = {}): VoiceCallConfig => {
  const base = VoiceCallConfigSchema.parse({
    enabled: true,
    provider: "plivo",
    fromNumber: "+15550000000",
    inboundPolicy: "disabled",
  });
  base.serve.port = 0;

  return {
    ...base,
    ...overrides,
    serve: {
      ...base.serve,
      ...overrides.serve,
    },
  };
};

async function postWebhookForm(server: VoiceCallWebhookServer, baseUrl: string, body: string) {
  const address = (
    server as unknown as { server?: { address?: () => unknown } }
  ).server?.address?.();
  const requestUrl = new URL(baseUrl);
  if (
    !address ||
    typeof address !== "object" ||
    !("port" in address) ||
    (typeof address.port !== "number" && typeof address.port !== "string") ||
    !address.port
  ) {
    throw new Error("voice webhook server did not expose a bound port");
  }
  requestUrl.port = String(address.port);
  return await fetch(requestUrl.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-plivo-signature-v2": "sig",
      "x-plivo-signature-v2-nonce": "nonce",
    },
    body,
  });
}

async function runDuplicateInboundReplayLifecycleTest(provider: FakeProvider) {
  const config = createConfig();
  const manager = new CallManager(config, createTestStorePath());
  await manager.initialize(provider, "https://example.com/voice/webhook");
  const server = new VoiceCallWebhookServer(config, manager, provider);

  try {
    const baseUrl = await server.start();
    const first = await postWebhookForm(server, baseUrl, "CallSid=CA123&From=%2B15552222222");
    const second = await postWebhookForm(server, baseUrl, "CallSid=CA123&From=%2B15552222222");
    return { first, second, manager };
  } finally {
    await server.stop();
  }
}

function expectSingleRejectedReplayHangup(params: {
  first: Response;
  second: Response;
  provider: FakeProvider;
  manager: CallManager;
}) {
  expect(params.first.status).toBe(200);
  expect(params.second.status).toBe(200);
  expect(params.provider.hangupCalls).toHaveLength(1);
  const [hangupCall] = params.provider.hangupCalls;
  if (!hangupCall) {
    throw new Error("Expected rejected replay hangup call");
  }
  expect(hangupCall.providerCallId).toBe("provider-inbound-1");
  expect(hangupCall.reason).toBe("hangup-bot");
  expect(params.manager.getCallByProviderCallId("provider-inbound-1")).toBeUndefined();
}

class RejectInboundReplayProvider extends FakeProvider {
  override verifyWebhook() {
    return { ok: true, verifiedRequestKey: "verified:req:reject-once" };
  }

  override parseWebhookEvent(_ctx: WebhookContext, options?: WebhookParseOptions) {
    return {
      statusCode: 200,
      events: [
        {
          id: "evt-reject-once",
          dedupeKey: options?.verifiedRequestKey,
          type: "call.initiated" as const,
          callId: "provider-inbound-1",
          providerCallId: "provider-inbound-1",
          timestamp: Date.now(),
          direction: "inbound" as const,
          from: "+15552222222",
          to: "+15550000000",
        },
      ],
    };
  }
}

class RejectInboundReplayWithHangupFailureProvider extends RejectInboundReplayProvider {
  override async hangupCall(input: Parameters<FakeProvider["hangupCall"]>[0]): Promise<void> {
    this.hangupCalls.push(input);
    throw new Error("hangup failed");
  }
}

describe("Voice-call webhook hangup-once lifecycle", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    installStateRuntime();
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
  });

  it("preserves finalized identity through signed HTTP callbacks and retries failed history reads", async () => {
    const authToken = "synthetic-terminal-webhook-token";
    const config = createConfig({
      provider: "twilio",
      agentId: "default-agent",
      twilio: { accountSid: "AC-fixture", authToken },
    });
    const provider = new TwilioProvider({ accountSid: "AC-fixture", authToken });
    vi.spyOn(provider, "initiateCall").mockResolvedValue({
      providerCallId: "CA-terminal-identity",
      status: "initiated",
    });
    const playback = vi.spyOn(provider, "playTts").mockResolvedValue();
    const hangup = vi.spyOn(provider, "hangupCall").mockResolvedValue();
    const storePath = createTestStorePath();
    const manager = new CallManager(config, storePath);
    const processing = vi.spyOn(manager, "processEvent");
    const server = new VoiceCallWebhookServer(config, manager, provider);
    try {
      const baseUrl = await server.start();
      provider.setPublicUrl(baseUrl);
      await manager.initialize(provider, baseUrl);
      const started = await manager.initiateCall("+15550000001", "agent:sales:voice:http", {
        agentId: "sales",
      });
      expect(started.success).toBe(true);
      const url = new URL(baseUrl);
      url.searchParams.set("callId", started.callId);
      url.searchParams.set("type", "status");
      const send = async (callStatus: string, sequence: string) => {
        const form = new URLSearchParams({
          CallSid: "CA-terminal-identity",
          CallStatus: callStatus,
          Direction: "outbound-api",
          From: "+15550000000",
          To: "+15550000001",
          SequenceNumber: sequence,
        });
        form.sort();
        const material = url.toString() + [...form].map(([key, value]) => key + value).join("");
        const signature = crypto.createHmac("sha1", authToken).update(material).digest("base64");
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-twilio-signature": signature,
          },
          body: form.toString(),
        });
        await response.text();
        return response.status;
      };

      expect(await send("in-progress", "1")).toBe(200);
      await expect(manager.speak(started.callId, "Keep the original transcript.")).resolves.toEqual(
        {
          success: true,
        },
      );
      await expect(manager.endCall(started.callId)).resolves.toEqual({ success: true });
      const history = await manager.getCallHistory();
      expect(history.at(-1)).toMatchObject({
        callId: started.callId,
        agentId: "sales",
        sessionKey: "agent:sales:voice:http",
        state: "hangup-bot",
        transcript: [expect.objectContaining({ text: "Keep the original transcript." })],
      });
      expect(await send("completed", "2")).toBe(200);
      const terminalCalls = processing.mock.calls.length;
      expect(await send("completed", "2")).toBe(200);
      expect(processing).toHaveBeenCalledTimes(terminalCalls);

      const state = getOptionalVoiceCallStateRuntime()?.state;
      if (!state) {
        throw new Error("expected fixture SQLite runtime");
      }
      const openStore = state.openSyncKeyedStore.bind(state);
      const fault = vi
        .spyOn(state, "openSyncKeyedStore")
        .mockImplementation(<T>(options: OpenKeyedStoreOptions) => {
          const store = openStore<T>(options);
          store.entries = () => {
            throw new Error("synthetic signed callback history failure");
          };
          return store;
        });
      try {
        expect(await send("completed", "3")).toBe(500);
      } finally {
        fault.mockRestore();
      }
      expect(await send("completed", "3")).toBe(200);
      expect(processing).toHaveBeenCalledTimes(terminalCalls + 2);
      expect(await manager.getCallHistory()).toEqual(history);
      expect(manager.getActiveCalls()).toEqual([]);
      expect(playback).toHaveBeenCalledTimes(1);
      expect(hangup).toHaveBeenCalledTimes(1);
    } finally {
      try {
        await server.stop();
      } finally {
        finalizeTestManagerCalls(manager);
        resetPluginStateStoreForTests();
        fs.rmSync(storePath, { recursive: true, force: true });
      }
    }
  });

  it("hangs up a rejected inbound replay only once across duplicate webhook delivery", async () => {
    const provider = new RejectInboundReplayProvider("plivo");
    const { first, second, manager } = await runDuplicateInboundReplayLifecycleTest(provider);
    expectSingleRejectedReplayHangup({ first, second, provider, manager });
  });

  it("does not attempt a second hangup when replay arrives after the first hangup fails", async () => {
    const provider = new RejectInboundReplayWithHangupFailureProvider("plivo");
    const { first, second, manager } = await runDuplicateInboundReplayLifecycleTest(provider);
    expectSingleRejectedReplayHangup({ first, second, provider, manager });
  });

  it("keeps rejected inbound replay keys after manager restart", async () => {
    const storePath = createTestStorePath();
    const config = createConfig();
    const firstProvider = new RejectInboundReplayProvider("plivo");
    const firstManager = new CallManager(config, storePath);
    await firstManager.initialize(firstProvider, "https://example.com/voice/webhook");
    const firstServer = new VoiceCallWebhookServer(config, firstManager, firstProvider);

    try {
      const baseUrl = await firstServer.start();
      const first = await postWebhookForm(
        firstServer,
        baseUrl,
        "CallSid=CA123&From=%2B15552222222",
      );
      expect(first.status).toBe(200);
    } finally {
      await firstServer.stop();
    }
    expect(firstProvider.hangupCalls).toHaveLength(1);

    const secondProvider = new RejectInboundReplayProvider("plivo");
    const secondManager = new CallManager(config, storePath);
    await secondManager.initialize(secondProvider, "https://example.com/voice/webhook");
    const secondServer = new VoiceCallWebhookServer(config, secondManager, secondProvider);

    try {
      const baseUrl = await secondServer.start();
      const replay = await postWebhookForm(
        secondServer,
        baseUrl,
        "CallSid=CA123&From=%2B15552222222",
      );
      expect(replay.status).toBe(200);
    } finally {
      await secondServer.stop();
    }

    expect(secondProvider.hangupCalls).toHaveLength(0);
    expect(secondManager.getCallByProviderCallId("provider-inbound-1")).toBeUndefined();
  });
});

describe("Voice-call webhook body limits", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    installStateRuntime();
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  it("answers an over-limit webhook with 413 and then closes the connection", async () => {
    // Driven over a real socket: the server answers while the sender is still uploading
    // and then closes, so a mocked response cannot show whether either half happened.
    const provider = new FakeProvider();
    const config = createConfig();
    const manager = new CallManager(config, createTestStorePath());
    await manager.initialize(provider, "https://example.com/voice/webhook");
    const server = new VoiceCallWebhookServer(config, manager, provider);

    try {
      const baseUrl = await server.start();
      const result = await postRawWebhook({
        url: baseUrl,
        body: `CallSid=CA123&From=%2B15552222222&Padding=${"x".repeat(2 * 1024 * 1024)}`,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-plivo-signature-v2": "sig",
          "x-plivo-signature-v2-nonce": "nonce",
        },
      });

      expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
      expect(result.closedByServer).toBe(true);
    } finally {
      await server.stop();
    }
  });
});
