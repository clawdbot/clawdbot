// Sms tests cover inbound plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
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
  const isControlCommandMessage = vi.fn((body: string) => body.trim().startsWith("/"));
  const shouldComputeCommandAuthorized = vi.fn((body: string) => body.trim().startsWith("/"));
  const run = vi.fn<
    (params: {
      turnAdoptionLifecycle?: { onAdopted: () => void | Promise<void> };
      adapter: {
        ingest: (msg: {
          from: string;
          to: string;
          body: string;
          messageSid: string;
          accountSid: string;
        }) => unknown;
        resolveTurn: (
          ingested: unknown,
        ) => Promise<{ route: { agentId: string; sessionKey: string } }>;
      };
    }) => void
  >();
  const buildContext = vi.fn();
  const resolveStorePath = vi.fn();
  const runtime = {
    commands: {
      isControlCommandMessage,
      shouldComputeCommandAuthorized,
    },
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
    isControlCommandMessage,
    shouldComputeCommandAuthorized,
    run,
    buildContext,
    resolveStorePath,
  };
}

const SMS_FROM = "+15551234567";
const SMS_TO = "+15557654321";
const SMS_SESSION_KEY = `agent:main:sms:direct:${SMS_FROM}`;

async function resolveAuthorizedSmsTurn(params: {
  body: string;
  messageSid: string;
  commandRequested?: boolean;
  isTextCommand?: boolean;
  receivedAt?: number;
  turnAdoptionLifecycle?: { onAdopted: () => void | Promise<void> };
}) {
  const mocks = createRuntime();
  if (params.commandRequested !== undefined) {
    mocks.shouldComputeCommandAuthorized.mockReturnValue(params.commandRequested);
  }
  if (params.isTextCommand !== undefined) {
    mocks.isControlCommandMessage.mockReturnValue(params.isTextCommand);
  }
  mocks.resolveAgentRoute.mockReturnValue({
    agentId: "main",
    accountId: "default",
    sessionKey: SMS_SESSION_KEY,
  });
  mocks.buildContext.mockReturnValue({ SessionKey: SMS_SESSION_KEY });

  const msg = {
    from: SMS_FROM,
    to: SMS_TO,
    body: params.body,
    messageSid: params.messageSid,
    accountSid: "AC123",
  };
  await dispatchSmsInboundEvent({
    cfg: {},
    account: createAccount({ dmPolicy: "allowlist", allowFrom: [SMS_FROM] }),
    channelRuntime: mocks.runtime,
    receivedAt: params.receivedAt ?? 1_700_000_000_123,
    ...(params.turnAdoptionLifecycle
      ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
      : {}),
    msg,
  });

  const runParams = expectDefined(mocks.run.mock.calls[0]?.[0], "SMS inbound run parameters");
  const turn = await runParams.adapter.resolveTurn(runParams.adapter.ingest(msg));
  return { ...mocks, runParams, turn };
}

describe("dispatchSmsInboundEvent", () => {
  it("creates and sends a pairing challenge for first-time SMS senders", async () => {
    const { runtime, readAllowFromStore, upsertPairingRequest } = createRuntime();

    await dispatchSmsInboundEvent({
      cfg: {},
      account: createAccount(),
      channelRuntime: runtime,
      receivedAt: 1_700_000_000_000,
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
    const turnAdoptionLifecycle = { onAdopted: vi.fn(async () => undefined) };
    const { resolveAgentRoute, runParams, buildContext, turn } = await resolveAuthorizedSmsTurn({
      body: "hello",
      messageSid: "SM-inbound",
      receivedAt: 1_700_000_000_123,
      turnAdoptionLifecycle,
    });

    expect(runParams.turnAdoptionLifecycle).toBe(turnAdoptionLifecycle);
    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "direct", id: SMS_FROM },
      }),
    );
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        timestamp: 1_700_000_000_123,
        from: `sms:${SMS_FROM}`,
        sender: expect.objectContaining({ id: SMS_FROM }),
        conversation: expect.objectContaining({ id: SMS_FROM }),
        reply: { to: `sms:${SMS_FROM}` },
        route: expect.objectContaining({
          routeSessionKey: SMS_SESSION_KEY,
          dispatchSessionKey: SMS_SESSION_KEY,
        }),
      }),
    );
    expect(turn.route.sessionKey).toBe(SMS_SESSION_KEY);
  });

  it("marks allowlisted SMS slash commands as text command turns", async () => {
    const { shouldComputeCommandAuthorized, isControlCommandMessage, buildContext } =
      await resolveAuthorizedSmsTurn({
        body: "/status",
        messageSid: "SM-command",
        commandRequested: true,
        isTextCommand: true,
      });

    expect(shouldComputeCommandAuthorized).toHaveBeenCalledWith("/status", {});
    expect(isControlCommandMessage).toHaveBeenCalledWith("/status", {});

    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          rawBody: "/status",
          commandBody: "/status",
        }),
        access: {
          commands: {
            authorized: true,
          },
        },
        command: {
          kind: "text-slash",
          body: "/status",
          authorized: true,
        },
        extra: expect.objectContaining({
          MessageSid: "SM-command",
          SenderE164: SMS_FROM,
        }),
      }),
    );
  });

  it("checks SMS command authorization for inline slash tokens without marking text command turns", async () => {
    const { shouldComputeCommandAuthorized, isControlCommandMessage, buildContext } =
      await resolveAuthorizedSmsTurn({
        body: "please inspect /tmp/foo",
        messageSid: "SM-inline-token",
        commandRequested: true,
        isTextCommand: false,
      });

    expect(shouldComputeCommandAuthorized).toHaveBeenCalledWith("please inspect /tmp/foo", {});
    expect(isControlCommandMessage).toHaveBeenCalledWith("please inspect /tmp/foo", {});

    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          rawBody: "please inspect /tmp/foo",
          commandBody: "please inspect /tmp/foo",
        }),
        access: {
          commands: {
            authorized: true,
          },
        },
        command: undefined,
        extra: expect.objectContaining({
          MessageSid: "SM-inline-token",
          SenderE164: SMS_FROM,
        }),
      }),
    );
  });
});
