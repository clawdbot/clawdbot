// Sms tests cover inbound plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { unlinkIfExists as unlinkIfExistsType } from "openclaw/plugin-sdk/media-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchSmsInboundEvent, type SmsChannelRuntime } from "./inbound.js";
import type { sendSmsViaTwilio as sendSmsViaTwilioType } from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";

const sendSmsViaTwilio = vi.hoisted(() =>
  vi.fn<typeof sendSmsViaTwilioType>(async () => ({ sid: "SM-pair", to: "+15551234567" })),
);
const unlinkIfExistsMock = vi.hoisted(() =>
  vi.fn<typeof unlinkIfExistsType>(async () => undefined),
);

vi.mock("./twilio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./twilio.js")>()),
  sendSmsViaTwilio,
}));
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  unlinkIfExists: unlinkIfExistsMock,
}));

type SmsTurnAdoptionLifecycle = NonNullable<
  Parameters<SmsChannelRuntime["inbound"]["run"]>[0]["turnAdoptionLifecycle"]
>;

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
      turnAdoptionLifecycle?: SmsTurnAdoptionLifecycle;
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
    }) => Promise<void>
  >(async () => undefined);
  const buildContext = vi.fn();
  const resolveStorePath = vi.fn();
  const saveRemoteMedia = vi.fn(async () => ({
    id: "media-1",
    path: "/tmp/mms-1.jpg",
    size: 128,
    contentType: "image/jpeg",
  }));
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
    media: {
      saveRemoteMedia,
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
    saveRemoteMedia,
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
    media: [],
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
  beforeEach(() => {
    unlinkIfExistsMock.mockClear();
  });

  it("creates and sends a pairing challenge for first-time SMS senders", async () => {
    const { runtime, readAllowFromStore, run, saveRemoteMedia, upsertPairingRequest } =
      createRuntime();

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
        media: [
          {
            url: `https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM-inbound/Media/ME${"a".repeat(32)}`,
            contentType: "image/jpeg",
          },
        ],
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
    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
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

  it("downloads authorized MMS media with Twilio auth and exposes media facts", async () => {
    const mocks = createRuntime();
    mocks.resolveAgentRoute.mockReturnValue({
      agentId: "main",
      accountId: "default",
      sessionKey: SMS_SESSION_KEY,
    });
    mocks.buildContext.mockReturnValue({ SessionKey: SMS_SESSION_KEY });
    const msg = {
      from: SMS_FROM,
      to: SMS_TO,
      body: "",
      messageSid: "MM-inbound",
      accountSid: "AC123",
      media: [
        {
          url: `https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM-inbound/Media/ME${"1".repeat(32)}`,
          contentType: "image/jpeg",
        },
      ],
    };

    await dispatchSmsInboundEvent({
      cfg: {},
      account: createAccount({ dmPolicy: "allowlist", allowFrom: [SMS_FROM] }),
      channelRuntime: mocks.runtime,
      receivedAt: 1_700_000_000_123,
      msg,
    });

    expect(mocks.saveRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: msg.media[0]?.url,
        maxBytes: 5 * 1024 * 1024,
        ssrfPolicy: { hostnameAllowlist: ["api.twilio.com"] },
        timeoutMs: 60_000,
        retry: {
          attempts: 2,
          minDelayMs: 500,
          maxDelayMs: 2_000,
          jitter: 0.2,
        },
        requestInit: {
          headers: {
            authorization: `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
          },
          signal: expect.any(AbortSignal),
        },
      }),
    );
    expect(unlinkIfExistsMock).toHaveBeenCalledOnce();
    expect(unlinkIfExistsMock).toHaveBeenCalledWith("/tmp/mms-1.jpg");
    const runParams = expectDefined(mocks.run.mock.calls[0]?.[0], "SMS inbound run parameters");
    await runParams.adapter.resolveTurn(runParams.adapter.ingest(msg));
    expect(mocks.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ bodyForAgent: "" }),
        media: [
          expect.objectContaining({
            path: "/tmp/mms-1.jpg",
            contentType: "image/jpeg",
            messageId: "MM-inbound",
          }),
        ],
      }),
    );
  });

  it("cleans materialized MMS files when inbound.run fails before adoption", async () => {
    const mocks = createRuntime();
    const runError = new Error("inbound dispatch failed");
    mocks.resolveAgentRoute.mockReturnValue({
      agentId: "main",
      accountId: "default",
      sessionKey: SMS_SESSION_KEY,
    });
    mocks.run.mockRejectedValueOnce(runError);

    await expect(
      dispatchSmsInboundEvent({
        cfg: {},
        account: createAccount({ dmPolicy: "allowlist", allowFrom: [SMS_FROM] }),
        channelRuntime: mocks.runtime,
        receivedAt: 1_700_000_000_123,
        turnAdoptionLifecycle: {
          onAdopted: vi.fn(async () => undefined),
          onDeferred: vi.fn(),
          onAbandoned: vi.fn(),
        },
        msg: {
          from: SMS_FROM,
          to: SMS_TO,
          body: "",
          messageSid: "MM-run-failure",
          accountSid: "AC123",
          media: [
            {
              url: `https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM-run-failure/Media/ME${"1".repeat(32)}`,
              contentType: "image/jpeg",
            },
          ],
        },
      }),
    ).rejects.toBe(runError);

    expect(unlinkIfExistsMock).toHaveBeenCalledOnce();
    expect(unlinkIfExistsMock).toHaveBeenCalledWith("/tmp/mms-1.jpg");
  });

  it("retains deferred MMS files until the turn is abandoned", async () => {
    const mocks = createRuntime();
    const events: string[] = [];
    unlinkIfExistsMock.mockImplementationOnce(async () => {
      events.push("cleanup");
    });
    const originalLifecycle: SmsTurnAdoptionLifecycle = {
      onAdopted: vi.fn(async () => undefined),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(() => {
        events.push("abandon");
      }),
    };
    let wrappedLifecycle: SmsTurnAdoptionLifecycle | undefined;
    mocks.resolveAgentRoute.mockReturnValue({
      agentId: "main",
      accountId: "default",
      sessionKey: SMS_SESSION_KEY,
    });
    mocks.run.mockImplementationOnce(async (runParams) => {
      wrappedLifecycle = runParams.turnAdoptionLifecycle;
      wrappedLifecycle?.onDeferred?.();
    });

    await dispatchSmsInboundEvent({
      cfg: {},
      account: createAccount({ dmPolicy: "allowlist", allowFrom: [SMS_FROM] }),
      channelRuntime: mocks.runtime,
      receivedAt: 1_700_000_000_123,
      turnAdoptionLifecycle: originalLifecycle,
      msg: {
        from: SMS_FROM,
        to: SMS_TO,
        body: "",
        messageSid: "MM-deferred",
        accountSid: "AC123",
        media: [
          {
            url: `https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM-deferred/Media/ME${"1".repeat(32)}`,
            contentType: "image/jpeg",
          },
        ],
      },
    });

    expect(originalLifecycle.onDeferred).toHaveBeenCalledOnce();
    expect(unlinkIfExistsMock).not.toHaveBeenCalled();
    wrappedLifecycle?.onAbandoned?.();
    await vi.waitFor(() => expect(originalLifecycle.onAbandoned).toHaveBeenCalledOnce());
    expect(unlinkIfExistsMock).toHaveBeenCalledOnce();
    expect(unlinkIfExistsMock).toHaveBeenCalledWith("/tmp/mms-1.jpg");
    expect(events).toEqual(["cleanup", "abandon"]);
  });

  it("retains MMS files after successful turn adoption", async () => {
    const mocks = createRuntime();
    const originalLifecycle: SmsTurnAdoptionLifecycle = {
      onAdopted: vi.fn(async () => undefined),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    };
    mocks.resolveAgentRoute.mockReturnValue({
      agentId: "main",
      accountId: "default",
      sessionKey: SMS_SESSION_KEY,
    });
    mocks.run.mockImplementationOnce(async (runParams) => {
      await runParams.turnAdoptionLifecycle?.onAdopted();
    });

    await dispatchSmsInboundEvent({
      cfg: {},
      account: createAccount({ dmPolicy: "allowlist", allowFrom: [SMS_FROM] }),
      channelRuntime: mocks.runtime,
      receivedAt: 1_700_000_000_123,
      turnAdoptionLifecycle: originalLifecycle,
      msg: {
        from: SMS_FROM,
        to: SMS_TO,
        body: "",
        messageSid: "MM-adopted",
        accountSid: "AC123",
        media: [
          {
            url: `https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM-adopted/Media/ME${"1".repeat(32)}`,
            contentType: "image/jpeg",
          },
        ],
      },
    });

    expect(originalLifecycle.onAdopted).toHaveBeenCalledOnce();
    expect(unlinkIfExistsMock).not.toHaveBeenCalled();
  });

  it("cleans deferred MMS files when turn adoption fails", async () => {
    const mocks = createRuntime();
    const adoptionError = new Error("durable adoption failed");
    const originalLifecycle: SmsTurnAdoptionLifecycle = {
      onAdopted: vi.fn(async () => {
        throw adoptionError;
      }),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    };
    mocks.resolveAgentRoute.mockReturnValue({
      agentId: "main",
      accountId: "default",
      sessionKey: SMS_SESSION_KEY,
    });
    mocks.run.mockImplementationOnce(async (runParams) => {
      runParams.turnAdoptionLifecycle?.onDeferred?.();
      await runParams.turnAdoptionLifecycle?.onAdopted();
    });

    await expect(
      dispatchSmsInboundEvent({
        cfg: {},
        account: createAccount({ dmPolicy: "allowlist", allowFrom: [SMS_FROM] }),
        channelRuntime: mocks.runtime,
        receivedAt: 1_700_000_000_123,
        turnAdoptionLifecycle: originalLifecycle,
        msg: {
          from: SMS_FROM,
          to: SMS_TO,
          body: "",
          messageSid: "MM-adoption-failed",
          accountSid: "AC123",
          media: [
            {
              url: `https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM-adoption-failed/Media/ME${"1".repeat(32)}`,
              contentType: "image/jpeg",
            },
          ],
        },
      }),
    ).rejects.toBe(adoptionError);

    expect(unlinkIfExistsMock).toHaveBeenCalledOnce();
    expect(unlinkIfExistsMock).toHaveBeenCalledWith("/tmp/mms-1.jpg");
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
