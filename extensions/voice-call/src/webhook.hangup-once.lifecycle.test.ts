import { afterEach, describe, expect, it } from "vitest";
import { VoiceCallConfigSchema, type VoiceCallConfig } from "./config.js";
import { CallManager } from "./manager.js";
import { createTestStorePath, FakeProvider } from "./manager.test-harness.js";
import type { WebhookContext, WebhookParseOptions } from "./types.js";
import { VoiceCallWebhookServer } from "./webhook.js";

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
  afterEach(() => {
    // Each test uses an isolated store path, so only server cleanup is needed.
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
});
