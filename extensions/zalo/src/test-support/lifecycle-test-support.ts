import { request as httpRequest } from "node:http";
import { expect, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import type { ResolvedZaloAccount } from "../types.js";

function resolveLifecycleAllowFrom(params: {
  dmPolicy: "open" | "pairing";
  allowFrom?: string[];
}): string[] | undefined {
  return params.allowFrom ?? (params.dmPolicy === "open" ? ["*"] : undefined);
}

function createLifecycleConfig(params: {
  accountId: string;
  dmPolicy: "open" | "pairing";
  allowFrom?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
}): OpenClawConfig {
  const webhookUrl = params.webhookUrl ?? "https://example.com/hooks/zalo";
  const webhookSecret = params.webhookSecret ?? "supersecret";
  const allowFrom = resolveLifecycleAllowFrom(params);
  return {
    channels: {
      zalo: {
        enabled: true,
        accounts: {
          [params.accountId]: {
            enabled: true,
            webhookUrl,
            webhookSecret, // pragma: allowlist secret
            dmPolicy: params.dmPolicy,
            ...(allowFrom ? { allowFrom } : {}),
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createLifecycleAccount(params: {
  accountId: string;
  dmPolicy: "open" | "pairing";
  allowFrom?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
}): ResolvedZaloAccount {
  const webhookUrl = params.webhookUrl ?? "https://example.com/hooks/zalo";
  const webhookSecret = params.webhookSecret ?? "supersecret";
  const allowFrom = resolveLifecycleAllowFrom(params);
  return {
    accountId: params.accountId,
    enabled: true,
    token: "zalo-token",
    tokenSource: "config",
    config: {
      webhookUrl,
      webhookSecret, // pragma: allowlist secret
      dmPolicy: params.dmPolicy,
      ...(allowFrom ? { allowFrom } : {}),
    },
  } as ResolvedZaloAccount;
}

export function createLifecycleMonitorSetup(params: {
  accountId: string;
  dmPolicy: "open" | "pairing";
  allowFrom?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
}) {
  return {
    account: createLifecycleAccount(params),
    config: createLifecycleConfig(params),
  };
}

export function createTextUpdate(params: {
  messageId: string;
  userId: string;
  userName: string;
  chatId: string;
  text?: string;
}) {
  return {
    event_name: "message.text.received",
    message: {
      from: { id: params.userId, name: params.userName },
      chat: { id: params.chatId, chat_type: "PRIVATE" as const },
      message_id: params.messageId,
      date: Math.floor(Date.now() / 1000),
      text: params.text ?? "hello from zalo",
    },
  };
}

export function createImageUpdate(params?: {
  messageId?: string;
  userId?: string;
  displayName?: string;
  chatId?: string;
  photoUrl?: string;
  date?: number;
}) {
  return {
    event_name: "message.image.received",
    message: {
      date: params?.date ?? 1774086023728,
      chat: { chat_type: "PRIVATE" as const, id: params?.chatId ?? "chat-123" },
      caption: "",
      message_id: params?.messageId ?? "msg-123",
      message_type: "CHAT_PHOTO",
      from: {
        id: params?.userId ?? "user-123",
        is_bot: false,
        display_name: params?.displayName ?? "Test User",
      },
      photo_url: params?.photoUrl ?? "https://example.com/test-image.jpg",
    },
  };
}

export function createImageLifecycleCore() {
  const finalizeInboundContextMock = vi.fn((ctx: Record<string, unknown>) => ctx);
  const buildChannelTurnContextMock = vi.fn(
    (params: {
      channel: string;
      accountId?: string;
      messageId?: string;
      timestamp?: number;
      from: string;
      sender: { id: string; name?: string };
      conversation: { kind: string; label?: string };
      route: {
        accountId?: string;
        routeSessionKey: string;
        dispatchSessionKey?: string;
      };
      reply: { to: string; originatingTo: string };
      message: { body?: string; rawBody: string; bodyForAgent?: string; commandBody?: string };
      media?: Array<{ path?: string; url?: string; contentType?: string }>;
      extra?: Record<string, unknown>;
    }) =>
      finalizeInboundContextMock({
        Body: params.message.body ?? params.message.rawBody,
        BodyForAgent: params.message.bodyForAgent ?? params.message.rawBody,
        RawBody: params.message.rawBody,
        CommandBody: params.message.commandBody ?? params.message.rawBody,
        From: params.from,
        To: params.reply.to,
        SessionKey: params.route.dispatchSessionKey ?? params.route.routeSessionKey,
        AccountId: params.route.accountId ?? params.accountId,
        ChatType: params.conversation.kind,
        ConversationLabel: params.conversation.label,
        SenderName: params.sender.name,
        SenderId: params.sender.id,
        Provider: params.channel,
        Surface: params.channel,
        MessageSid: params.messageId,
        Timestamp: params.timestamp,
        MediaPath: params.media?.[0]?.path,
        MediaType: params.media?.[0]?.contentType,
        MediaUrl: params.media?.[0]?.url ?? params.media?.[0]?.path,
        OriginatingChannel: params.channel,
        OriginatingTo: params.reply.originatingTo,
        ...params.extra,
      }),
  );
  const recordInboundSessionMock = vi.fn(async () => undefined);
  const fetchRemoteMediaMock = vi.fn(async () => ({
    buffer: Buffer.from("image-bytes"),
    contentType: "image/jpeg",
  }));
  const saveMediaBufferMock = vi.fn(async () => ({
    path: "/tmp/zalo-photo.jpg",
    contentType: "image/jpeg",
  }));
  const readAllowFromStoreMock = vi.fn(async () => [] as string[]);
  const upsertPairingRequestMock = vi.fn(async () => ({ code: "PAIRCODE", created: true }));
  const core = {
    logging: {
      shouldLogVerbose: vi.fn(
        () => false,
      ) as unknown as PluginRuntime["logging"]["shouldLogVerbose"],
    },
    channel: {
      pairing: {
        readAllowFromStore:
          readAllowFromStoreMock as unknown as PluginRuntime["channel"]["pairing"]["readAllowFromStore"],
        upsertPairingRequest:
          upsertPairingRequestMock as unknown as PluginRuntime["channel"]["pairing"]["upsertPairingRequest"],
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "main",
          accountId: "default",
          sessionKey: "agent:main:zalo:direct:chat-123",
        })) as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
      },
      session: {
        resolveStorePath: vi.fn(
          () => "/tmp/zalo-sessions.json",
        ) as unknown as PluginRuntime["channel"]["session"]["resolveStorePath"],
        readSessionUpdatedAt: vi.fn(
          () => undefined,
        ) as unknown as PluginRuntime["channel"]["session"]["readSessionUpdatedAt"],
        recordInboundSession:
          recordInboundSessionMock as unknown as PluginRuntime["channel"]["session"]["recordInboundSession"],
      },
      text: {
        resolveMarkdownTableMode: vi.fn(
          () => "code",
        ) as unknown as PluginRuntime["channel"]["text"]["resolveMarkdownTableMode"],
      },
      media: {
        fetchRemoteMedia:
          fetchRemoteMediaMock as unknown as PluginRuntime["channel"]["media"]["fetchRemoteMedia"],
        saveMediaBuffer:
          saveMediaBufferMock as unknown as PluginRuntime["channel"]["media"]["saveMediaBuffer"],
      },
      reply: {
        finalizeInboundContext:
          finalizeInboundContextMock as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
        resolveEnvelopeFormatOptions: vi.fn(() => ({
          template: "channel+name+time",
        })) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
        formatAgentEnvelope: vi.fn(
          (opts: { body: string }) => opts.body,
        ) as unknown as PluginRuntime["channel"]["reply"]["formatAgentEnvelope"],
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(
          async () => undefined,
        ) as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
      },
      turn: {
        run: vi.fn(async (params: Parameters<PluginRuntime["channel"]["turn"]["run"]>[0]) => {
          const input = await params.adapter.ingest(params.raw);
          if (!input) {
            return {
              admission: { kind: "drop" as const, reason: "ingest-null" },
              dispatched: false,
            };
          }
          const resolved = await params.adapter.resolveTurn(
            input,
            {
              kind: "message",
              canStartAgentTurn: true,
            },
            {},
          );
          await resolved.recordInboundSession({
            storePath: resolved.storePath,
            sessionKey: resolved.ctxPayload.SessionKey ?? resolved.routeSessionKey,
            ctx: resolved.ctxPayload,
            groupResolution: resolved.record?.groupResolution,
            createIfMissing: resolved.record?.createIfMissing,
            updateLastRoute: resolved.record?.updateLastRoute,
            onRecordError: resolved.record?.onRecordError ?? (() => undefined),
          });
          if ("runDispatch" in resolved) {
            const dispatchResult = await resolved.runDispatch();
            return {
              admission: { kind: "dispatch" as const },
              dispatched: true,
              ctxPayload: resolved.ctxPayload,
              routeSessionKey: resolved.routeSessionKey,
              dispatchResult,
            };
          }
          const dispatchResult = await resolved.dispatchReplyWithBufferedBlockDispatcher({
            ctx: resolved.ctxPayload,
            cfg: resolved.cfg,
            dispatcherOptions: {
              ...resolved.dispatcherOptions,
              deliver: async (...args: Parameters<typeof resolved.delivery.deliver>) => {
                await resolved.delivery.deliver(...args);
              },
              onError: resolved.delivery.onError,
            },
            replyOptions: resolved.replyOptions,
            replyResolver: resolved.replyResolver,
          });
          return {
            admission: { kind: "dispatch" as const },
            dispatched: true,
            ctxPayload: resolved.ctxPayload,
            routeSessionKey: resolved.routeSessionKey,
            dispatchResult,
          };
        }) as unknown as PluginRuntime["channel"]["turn"]["run"],
        runAssembled: vi.fn(
          async (params: Parameters<PluginRuntime["channel"]["turn"]["runAssembled"]>[0]) => {
            await params.recordInboundSession({
              storePath: params.storePath,
              sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
              ctx: params.ctxPayload,
              groupResolution: params.record?.groupResolution,
              createIfMissing: params.record?.createIfMissing,
              updateLastRoute: params.record?.updateLastRoute,
              onRecordError: params.record?.onRecordError ?? (() => undefined),
            });
            const dispatchResult = await params.dispatchReplyWithBufferedBlockDispatcher({
              ctx: params.ctxPayload,
              cfg: params.cfg,
              dispatcherOptions: {
                ...params.dispatcherOptions,
                deliver: async (...args: Parameters<typeof params.delivery.deliver>) => {
                  await params.delivery.deliver(...args);
                },
                onError: params.delivery.onError,
              },
              replyOptions: params.replyOptions,
              replyResolver: params.replyResolver,
            });
            return {
              admission: params.admission ?? { kind: "dispatch" as const },
              dispatched: true,
              ctxPayload: params.ctxPayload,
              routeSessionKey: params.routeSessionKey,
              dispatchResult,
            };
          },
        ) as unknown as PluginRuntime["channel"]["turn"]["runAssembled"],
        buildContext:
          buildChannelTurnContextMock as unknown as PluginRuntime["channel"]["turn"]["buildContext"],
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(
          () => false,
        ) as unknown as PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"],
        resolveCommandAuthorizedFromAuthorizers: vi.fn(
          () => false,
        ) as unknown as PluginRuntime["channel"]["commands"]["resolveCommandAuthorizedFromAuthorizers"],
        isControlCommandMessage: vi.fn(
          () => false,
        ) as unknown as PluginRuntime["channel"]["commands"]["isControlCommandMessage"],
      },
    },
  } as PluginRuntime;
  return {
    core,
    finalizeInboundContextMock,
    recordInboundSessionMock,
    fetchRemoteMediaMock,
    saveMediaBufferMock,
    readAllowFromStoreMock,
    upsertPairingRequestMock,
  };
}

export function expectImageLifecycleDelivery(params: {
  fetchRemoteMediaMock: ReturnType<typeof vi.fn>;
  saveMediaBufferMock: ReturnType<typeof vi.fn>;
  finalizeInboundContextMock: ReturnType<typeof vi.fn>;
  recordInboundSessionMock: ReturnType<typeof vi.fn>;
  photoUrl?: string;
  senderName?: string;
  mediaPath?: string;
  mediaType?: string;
}) {
  const photoUrl = params.photoUrl ?? "https://example.com/test-image.jpg";
  const senderName = params.senderName ?? "Test User";
  const mediaPath = params.mediaPath ?? "/tmp/zalo-photo.jpg";
  const mediaType = params.mediaType ?? "image/jpeg";
  expect(params.fetchRemoteMediaMock).toHaveBeenCalledWith({
    url: photoUrl,
    maxBytes: 5 * 1024 * 1024,
  });
  expect(params.saveMediaBufferMock).toHaveBeenCalledTimes(1);
  expect(params.finalizeInboundContextMock).toHaveBeenCalledWith(
    expect.objectContaining({
      SenderName: senderName,
      MediaPath: mediaPath,
      MediaType: mediaType,
    }),
  );
  expect(params.recordInboundSessionMock).toHaveBeenCalledWith(
    expect.objectContaining({
      ctx: expect.objectContaining({
        SenderName: senderName,
        MediaPath: mediaPath,
        MediaType: mediaType,
      }),
    }),
  );
}

export async function settleAsyncWork(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function postWebhookUpdate(params: {
  baseUrl: string;
  path: string;
  secret: string;
  payload: Record<string, unknown>;
}) {
  const url = new URL(params.path, params.baseUrl);
  const body = JSON.stringify(params.payload);
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-bot-api-secret-token": params.secret,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function postWebhookReplay(params: {
  baseUrl: string;
  path: string;
  secret: string;
  payload: Record<string, unknown>;
  settleBeforeReplay?: boolean;
}) {
  const first = await postWebhookUpdate(params);
  if (params.settleBeforeReplay) {
    await settleAsyncWork();
  }
  const replay = await postWebhookUpdate(params);
  return { first, replay };
}
