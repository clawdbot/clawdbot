// Sms tests cover inbound plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { dispatchSmsInboundEvent, type SmsChannelRuntime } from "./inbound.js";
import type { sendSmsViaTwilio as sendSmsViaTwilioType } from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";

const sendSmsViaTwilio = vi.hoisted(() =>
  vi.fn<typeof sendSmsViaTwilioType>(async () => ({ sid: "SM-pair", to: "+15551234567" })),
);

vi.mock("./twilio.js", () => ({
  sendSmsViaTwilio,
}));

function createAccount(overrides: Partial<ResolvedSmsAccount> = {}): ResolvedSmsAccount {
  return {
    accountId: "default",
    enabled: true,
    accountSid: "AC123",
    authToken: "secret",
    fromNumber: "+15557654321",
    messagingServiceSid: "",
    defaultTo: "",
    webhookPath: "/webhooks/sms",
    publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit: 1500,
    ...overrides,
  };
}

function createRuntime() {
  const readAllowFromStore = vi.fn(async () => [] as string[]);
  const upsertPairingRequest = vi.fn(async () => ({ code: "PAIR123", created: true }));
  const resolveAgentRoute = vi.fn();
  const run = vi.fn<
    (params: {
      adapter: {
        ingest: (msg: {
          from: string;
          to: string;
          body: string;
          messageSid: string;
          accountSid: string;
        }) => unknown;
        resolveTurn: (ingested: unknown) => Promise<{ routeSessionKey: string }>;
      };
    }) => void
  >();
  const buildContext = vi.fn();
  const resolveStorePath = vi.fn();
  const runtime = {
    pairing: {
      readAllowFromStore,
      upsertPairingRequest,
    },
    routing: {
      resolveAgentRoute,
    },
    inbound: {
      run,
      buildContext,
    },
    session: {
      resolveStorePath,
      recordInboundSession: vi.fn(),
    },
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
    },
  } as unknown as SmsChannelRuntime;
  return {
    runtime,
    readAllowFromStore,
    upsertPairingRequest,
    resolveAgentRoute,
    run,
    buildContext,
    resolveStorePath,
  };
}

describe("dispatchSmsInboundEvent", () => {
  it("creates and sends a pairing challenge for first-time SMS senders", async () => {
    const { runtime, readAllowFromStore, upsertPairingRequest } = createRuntime();

    await dispatchSmsInboundEvent({
      cfg: {},
      account: createAccount(),
      channelRuntime: runtime,
      msg: {
        from: "+15551234567",
        to: "+15557654321",
        body: "hello",
        messageSid: "SM-inbound",
        accountSid: "AC123",
      },
    });

    expect(readAllowFromStore).toHaveBeenCalledWith({
      channel: "sms",
      accountId: "default",
    });
    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "sms",
      accountId: "default",
      id: "+15551234567",
      meta: undefined,
    });
    expect(sendSmsViaTwilio).toHaveBeenCalledOnce();
    expect(sendSmsViaTwilio).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15551234567",
        text: expect.stringContaining("PAIR123"),
      }),
    );
  });

  it("uses the canonical routed session key for authorized SMS turns", async () => {
    const { runtime, resolveAgentRoute, run, buildContext, resolveStorePath } = createRuntime();
    resolveAgentRoute.mockReturnValue({
      agentId: "main",
      accountId: "default",
      sessionKey: "agent:main:sms:direct:+15551234567",
    });
    buildContext.mockReturnValue({ SessionKey: "agent:main:sms:direct:+15551234567" });
    resolveStorePath.mockReturnValue("/tmp/openclaw-sessions");

    await dispatchSmsInboundEvent({
      cfg: {},
      account: createAccount({
        dmPolicy: "allowlist",
        allowFrom: ["+15551234567"],
      }),
      channelRuntime: runtime,
      msg: {
        from: "+15551234567",
        to: "+15557654321",
        body: "hello",
        messageSid: "SM-inbound",
        accountSid: "AC123",
      },
    });

    const runParams = run.mock.calls[0]?.[0];
    const ingested = runParams.adapter.ingest({
      from: "+15551234567",
      to: "+15557654321",
      body: "hello",
      messageSid: "SM-inbound",
      accountSid: "AC123",
    });
    const turn = await runParams.adapter.resolveTurn(ingested);

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "direct", id: "+15551234567" },
      }),
    );
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "sms:+15551234567",
        sender: expect.objectContaining({ id: "+15551234567" }),
        conversation: expect.objectContaining({ id: "+15551234567" }),
        reply: { to: "sms:+15551234567" },
        route: expect.objectContaining({
          routeSessionKey: "agent:main:sms:direct:+15551234567",
          dispatchSessionKey: "agent:main:sms:direct:+15551234567",
        }),
      }),
    );
    expect(turn.routeSessionKey).toBe("agent:main:sms:direct:+15551234567");
  });
});
