// Feishu delivery trace goldens: replayable wire-level lifecycle recordings.
//
// IN events are fed straight into the reply-dispatcher plan (dispatcher,
// delivery, and replyOptions callbacks); OUT
// events are recorded at the mocked Lark SDK client and the mocked CardKit
// HTTP fetch, so streaming-card entity calls are captured at the wire seam.
// Refresh goldens with OPENCLAW_TRACE_UPDATE=1 (see delivery-trace harness docs).
import {
  deliveryTraceScenarios,
  expectDeliveryTraceMatchesGolden,
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type DeliveryTraceScenarioName,
  type WireRecorder,
} from "openclaw/plugin-sdk/channel-contract-testing";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import type { ResolvedFeishuAccount } from "./types.js";

type RecordedWireCall = Parameters<WireRecorder["recordWireCall"]>[0];
type CreateFeishuReplyDispatcher =
  typeof import("./reply-dispatcher.js").createFeishuReplyDispatcher;
type StreamingStartBackoffMap =
  typeof import("./reply-dispatcher-state.js").streamingStartBackoffUntilByAccount;

type FeishuTraceState = {
  recordWireCall: (call: RecordedWireCall) => void;
  account: ResolvedFeishuAccount | null;
  larkClient: unknown;
  cardKitFetch: typeof fetch | null;
  messageCount: number;
  reactionCount: number;
  cardCount: number;
  setupCount: number;
  loadedMedia: { buffer: Buffer; fileName: string; contentType: string } | null;
  omitNextMessageReceipt: boolean;
  wireFaults: Array<{ fault: "rate-limit"; retryAfterMs: number }>;
};

const traceState = vi.hoisted(
  (): FeishuTraceState => ({
    recordWireCall: () => {},
    account: null,
    larkClient: null,
    cardKitFetch: null,
    messageCount: 0,
    reactionCount: 0,
    cardCount: 0,
    setupCount: 0,
    loadedMedia: null,
    omitNextMessageReceipt: false,
    wireFaults: [],
  }),
);

vi.mock("./accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accounts.js")>();
  const resolveTraceAccount = () => {
    if (!traceState.account) {
      throw new Error("trace account not initialized");
    }
    return traceState.account;
  };
  return {
    ...actual,
    resolveFeishuAccount: resolveTraceAccount,
    resolveFeishuRuntimeAccount: resolveTraceAccount,
  };
});

vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  return {
    ...actual,
    createFeishuClient: () => {
      if (!traceState.larkClient) {
        throw new Error("trace Lark client not initialized");
      }
      return traceState.larkClient;
    },
  };
});

// Module-scoped runtime stub (not the shared global runtime slot) so
// isolate=false workers never leak this stub into other feishu test files.
// channel.text uses the real chunking/table helpers because overflow
// pagination behavior is part of the recorded lifecycle.
vi.mock("./runtime.js", async () => {
  const replyChunking = await import("openclaw/plugin-sdk/reply-chunking");
  const textChunking = await import("openclaw/plugin-sdk/text-chunking");
  const markdownTables = await import("openclaw/plugin-sdk/markdown-table-runtime");
  const runtime = {
    media: {
      loadWebMedia: async () => {
        if (!traceState.loadedMedia) {
          throw new Error("trace media not initialized");
        }
        return traceState.loadedMedia;
      },
    },
    channel: {
      text: {
        resolveTextChunkLimit: replyChunking.resolveTextChunkLimit,
        resolveChunkMode: replyChunking.resolveChunkMode,
        chunkTextWithMode: replyChunking.chunkTextWithMode,
        chunkMarkdownTextWithMode: replyChunking.chunkMarkdownTextWithMode,
        convertMarkdownTables: textChunking.convertMarkdownTables,
        resolveMarkdownTableMode: markdownTables.resolveMarkdownTableMode,
      },
    },
    logging: { shouldLogVerbose: () => false },
  };
  return {
    getFeishuRuntime: () => runtime,
    setFeishuRuntime: () => {},
  };
});

// Keep the real streaming-card behavior (throttle, CardKit sequences, close
// settings) and inject only a hermetic recording fetch for its HTTP calls.
vi.mock("./streaming-card.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./streaming-card.js")>();
  class RecordingFeishuStreamingSession extends actual.FeishuStreamingSession {
    constructor(
      client: ConstructorParameters<typeof actual.FeishuStreamingSession>[0],
      creds: ConstructorParameters<typeof actual.FeishuStreamingSession>[1],
      log?: ConstructorParameters<typeof actual.FeishuStreamingSession>[2],
    ) {
      if (!traceState.cardKitFetch) {
        throw new Error("trace CardKit fetch not initialized");
      }
      super(client, creds, log, { fetchImpl: traceState.cardKitFetch });
    }
  }
  return { ...actual, FeishuStreamingSession: RecordingFeishuStreamingSession };
});

let createFeishuReplyDispatcher: CreateFeishuReplyDispatcher;
let feishuOutbound: typeof import("./outbound.js").feishuOutbound;
let streamingStartBackoffUntilByAccount: StreamingStartBackoffMap;

beforeAll(async () => {
  // Collection can share a worker with suites that mock the same Feishu modules.
  // Reload only after this file's hoisted mocks are registered.
  vi.resetModules();
  ({ createFeishuReplyDispatcher } = await import("./reply-dispatcher.js"));
  ({ feishuOutbound } = await import("./outbound.js"));
  ({ streamingStartBackoffUntilByAccount } = await import("./reply-dispatcher-state.js"));
});

afterAll(() => {
  vi.doUnmock("./accounts.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./runtime.js");
  vi.doUnmock("./streaming-card.js");
  vi.resetModules();
});

afterEach(() => {
  traceState.account = null;
  traceState.larkClient = null;
  traceState.cardKitFetch = null;
  traceState.omitNextMessageReceipt = false;
  traceState.loadedMedia = null;
  traceState.wireFaults = [];
  streamingStartBackoffUntilByAccount.clear();
});

function jsonResponse(payload: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new Error("expected JSON string body");
  }
  return JSON.parse(value) as Record<string, unknown>;
}

function nextMessageId(): string {
  traceState.messageCount += 1;
  return `om-${traceState.messageCount}`;
}

function createRecordingLarkClient() {
  const messageSendResult = (messageId: string) => {
    const data = traceState.omitNextMessageReceipt ? {} : { message_id: messageId };
    traceState.omitNextMessageReceipt = false;
    return { code: 0, msg: "ok", data };
  };
  return {
    im: {
      file: {
        create: (args: { data: { file_name: string; file_type: string } }) => {
          traceState.recordWireCall({
            method: "im.file.create",
            payload: { file_name: args.data.file_name, file_type: args.data.file_type },
            result: { file_key: "file-trace" },
          });
          return Promise.resolve({ file_key: "file-trace" });
        },
      },
      message: {
        create: (args: {
          params: { receive_id_type: string };
          data: { receive_id: string; msg_type: string; content: string; root_id?: string };
        }) => {
          const messageId = nextMessageId();
          const response = messageSendResult(messageId);
          traceState.recordWireCall({
            method: "im.message.create",
            target: args.data.receive_id,
            payload: {
              receive_id_type: args.params.receive_id_type,
              msg_type: args.data.msg_type,
              content: parseJsonRecord(args.data.content),
              ...(args.data.root_id ? { root_id: args.data.root_id } : {}),
            },
            result: response.data,
          });
          return Promise.resolve(response);
        },
        reply: (args: {
          path: { message_id: string };
          data: { msg_type: string; content: string; reply_in_thread?: boolean };
        }) => {
          const messageId = nextMessageId();
          const response = messageSendResult(messageId);
          traceState.recordWireCall({
            method: "im.message.reply",
            target: args.path.message_id,
            payload: {
              msg_type: args.data.msg_type,
              content: parseJsonRecord(args.data.content),
              ...(args.data.reply_in_thread ? { reply_in_thread: true } : {}),
            },
            result: response.data,
          });
          return Promise.resolve(response);
        },
        delete: (args: { path: { message_id: string } }) => {
          traceState.recordWireCall({
            method: "im.message.delete",
            target: args.path.message_id,
            result: { code: 0 },
          });
          return Promise.resolve({ code: 0, msg: "ok" });
        },
      },
      messageReaction: {
        create: (args: {
          path: { message_id: string };
          data: { reaction_type: { emoji_type: string } };
        }) => {
          traceState.reactionCount += 1;
          const reactionId = `reaction-${traceState.reactionCount}`;
          traceState.recordWireCall({
            method: "im.messageReaction.create",
            target: args.path.message_id,
            payload: { emoji_type: args.data.reaction_type.emoji_type },
            result: { reaction_id: reactionId },
          });
          return Promise.resolve({ code: 0, msg: "ok", data: { reaction_id: reactionId } });
        },
        delete: (args: { path: { message_id: string; reaction_id: string } }) => {
          traceState.recordWireCall({
            method: "im.messageReaction.delete",
            target: args.path.message_id,
            payload: { reaction_id: args.path.reaction_id },
            result: { code: 0 },
          });
          return Promise.resolve({ code: 0, msg: "ok", data: {} });
        },
      },
    },
  };
}

function createRecordingCardKitFetch(): typeof fetch {
  return withFetchPreconnect(
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const method = init?.method ?? "GET";
      const wirePath = url.pathname.replace(/^\/open-apis/, "");
      const record = (payload: unknown, result: unknown) => {
        traceState.recordWireCall({ method: `${method} ${wirePath}`, payload, result });
      };
      if (wirePath === "/auth/v3/tenant_access_token/internal") {
        // Recorded without the request body: credentials and token values never
        // belong in committed goldens, and the run-scoped app id must not leak
        // into byte-stable fixtures.
        record(undefined, { code: 0 });
        return jsonResponse({
          code: 0,
          msg: "ok",
          // Short dummy value: autoreview's secret scanner rejects longer
          // token-keyed strings even in fixtures.
          tenant_access_token: "tat-dummy",
          expire: 7200,
        });
      }
      if (wirePath === "/cardkit/v1/cards") {
        traceState.cardCount += 1;
        const cardId = `card-${traceState.cardCount}`;
        const body = parseJsonRecord(init?.body);
        record({ type: body.type, card: parseJsonRecord(body.data) }, { code: 0, card_id: cardId });
        return jsonResponse({ code: 0, msg: "ok", data: { card_id: cardId } });
      }
      if (wirePath.endsWith("/elements/content/content")) {
        const body = parseJsonRecord(init?.body);
        const fault = traceState.wireFaults.shift();
        if (fault) {
          record(body, { status: 429, retryAfterMs: fault.retryAfterMs });
          return jsonResponse({ code: 99991400, msg: "rate limited" }, 429, {
            "retry-after": String(Math.ceil(fault.retryAfterMs / 1000)),
          });
        }
        record(body, { code: 0 });
        return jsonResponse({ code: 0, msg: "ok" });
      }
      if (wirePath.endsWith("/elements/content")) {
        const body = parseJsonRecord(init?.body);
        record(
          { element: parseJsonRecord(body.element), sequence: body.sequence, uuid: body.uuid },
          { code: 0 },
        );
        return jsonResponse({ code: 0, msg: "ok" });
      }
      if (wirePath.endsWith("/elements/note/content")) {
        record(parseJsonRecord(init?.body), { code: 0 });
        return jsonResponse({ code: 0, msg: "ok" });
      }
      if (wirePath.endsWith("/settings")) {
        const body = parseJsonRecord(init?.body);
        record(
          { settings: parseJsonRecord(body.settings), sequence: body.sequence, uuid: body.uuid },
          { code: 0 },
        );
        return jsonResponse({ code: 0, msg: "ok" });
      }
      throw new Error(`Unexpected CardKit request: ${method} ${url.pathname}`);
    }),
  ) as typeof fetch;
}

function makeTraceAccount(scenario: DeliveryTraceScenarioName): ResolvedFeishuAccount {
  traceState.setupCount += 1;
  return {
    accountId: "main",
    selectionSource: "fallback",
    enabled: true,
    configured: true,
    // Run-unique app id busts the module-level CardKit token cache so every
    // scenario (and any same-worker re-run) records exactly one token fetch.
    appId: `app-${scenario}-${traceState.setupCount}`,
    appSecret: "test-secret",
    domain: "feishu",
    // Nested streaming.mode "partial" matches the retired `streaming: true`
    // boolean, so the recorded wire goldens stay byte-identical.
    config: FeishuConfigSchema.parse({ renderMode: "auto", streaming: { mode: "partial" } }),
  };
}

function setupFeishuTrace(recorder: WireRecorder, scenario: DeliveryTraceScenarioName) {
  traceState.recordWireCall = recorder.recordWireCall;
  traceState.messageCount = 0;
  traceState.reactionCount = 0;
  traceState.cardCount = 0;
  traceState.wireFaults = [];
  traceState.account = makeTraceAccount(scenario);
  traceState.larkClient = createRecordingLarkClient();
  traceState.cardKitFetch = createRecordingCardKitFetch();

  const created = createFeishuReplyDispatcher({
    cfg: {} as never,
    agentId: "agent",
    runtime: { log: () => {}, error: () => {} } as never,
    chatId: "oc-trace-chat",
    sendTarget: "oc-trace-chat",
    replyToMessageId: "om-inbound",
  });
  const options = created.dispatcherOptions;

  return async (step: DeliveryTraceInStep) => {
    switch (step.kind) {
      case "reply-start":
        await options.onReplyStart?.();
        break;
      case "partial":
        created.replyOptions.onPartialReply?.({ text: step.text });
        break;
      case "block-final":
        await created.delivery.deliver({ text: step.text }, { kind: "block" });
        break;
      case "tool-progress":
        created.replyOptions.onToolStart?.({ name: step.name, phase: step.phase });
        break;
      case "final":
        await created.delivery.deliver(
          {
            ...(step.text !== undefined ? { text: step.text } : {}),
            ...(step.mediaUrls ? { mediaUrls: step.mediaUrls } : {}),
            ...(step.isError ? { isError: true } : {}),
          },
          { kind: "final" },
        );
        break;
      case "cancel":
        // An aborted run stops emitting payloads; closeout happens on idle.
        break;
      case "idle":
        await options.onIdle?.();
        options.onCleanup?.();
        break;
      case "wire-fault":
        if (step.fault !== "rate-limit") {
          throw new Error("feishu trace scenarios script only rate-limit wire faults");
        }
        traceState.wireFaults.push({ fault: step.fault, retryAfterMs: step.retryAfterMs });
        break;
    }
  };
}

const FEISHU_TRACE_SCENARIOS: readonly DeliveryTraceScenarioName[] = [
  "streaming-happy",
  "final-only",
  "cancel-mid-stream",
  "rate-limit-during-preview",
  "overflow-pagination",
];

describe("feishu delivery trace goldens", () => {
  it("updates the accepted card without a duplicate send when its message receipt is absent", async () => {
    const events = await runDeliveryTraceScenario({
      scenario: deliveryTraceScenarios["final-only"],
      setup: (recorder) => {
        const dispatch = setupFeishuTrace(recorder, "final-only");
        traceState.omitNextMessageReceipt = true;
        return dispatch;
      },
    });
    const messages = events.filter(
      (event) => event.kind === "im.message.reply" || event.kind === "im.message.create",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ data: { result: {} } });
    expect(
      events.some((event) =>
        event.kind.startsWith("PUT /cardkit/v1/cards/card-1/elements/content/content"),
      ),
    ).toBe(true);
    expect(events.some((event) => event.kind === "PATCH /cardkit/v1/cards/card-1/settings")).toBe(
      true,
    );
    expect(streamingStartBackoffUntilByAccount.has("main")).toBe(false);
  });

  it.each(["outbound", "dispatcher"] as const)(
    "preserves caption visibility when %s voice-looking media resolves to a PDF",
    async (surface) => {
      const acceptedMessageIds: string[] = [];
      const events = await runDeliveryTraceScenario({
        scenario: {
          name: `feishu-${surface}-authoritative-voice-media`,
          steps: [{ kind: "final", text: "Critical caption must remain visible" }],
        },
        setup: (recorder) => {
          setupFeishuTrace(recorder, "final-only");
          traceState.loadedMedia = {
            buffer: Buffer.from("%PDF-1.7 trace document"),
            fileName: "report.pdf",
            contentType: "application/pdf",
          };
          traceState.account = {
            ...makeTraceAccount("final-only"),
            config: FeishuConfigSchema.parse({ renderMode: "raw", streaming: { mode: "off" } }),
          };
          return async (step) => {
            if (step.kind !== "final") {
              throw new Error("unexpected authoritative-media trace step");
            }
            if (surface === "outbound") {
              await feishuOutbound.sendMedia?.({
                cfg: {},
                to: "oc-trace-chat",
                text: step.text ?? "",
                mediaUrl: "https://example.com/download.ogg",
                onDeliveryResult: async (result) => {
                  acceptedMessageIds.push(result.messageId);
                },
              });
              return;
            }
            const dispatcher = createFeishuReplyDispatcher({
              cfg: {} as never,
              agentId: "agent",
              runtime: {} as never,
              chatId: "oc-trace-chat",
              sendTarget: "oc-trace-chat",
            });
            await dispatcher.delivery.deliver(
              { text: step.text, mediaUrl: "https://example.com/download.ogg" },
              { kind: "final" },
            );
          };
        },
      });
      const sends = events.filter((event) => event.kind === "im.message.create");

      expect(events.find((event) => event.kind === "im.file.create")).toMatchObject({
        data: { payload: { file_name: "report.pdf", file_type: "pdf" } },
      });
      expect(sends).toHaveLength(2);
      expect(sends).toMatchObject([
        { data: { payload: { msg_type: "file" } } },
        {
          data: {
            payload: {
              msg_type: "post",
              content: {
                zh_cn: { content: [[{ tag: "md", text: "Critical caption must remain visible" }]] },
              },
            },
          },
        },
      ]);
      if (surface === "outbound") {
        expect(acceptedMessageIds).toEqual(["om-1", "om-2"]);
      }
    },
  );

  it.each([
    { label: "inferred native voice", audioAsVoice: false },
    { label: "explicit voice intent", audioAsVoice: true },
  ])("does not repeat visible TTS text when $label resolves to a PDF", async (voice) => {
    const events = await runDeliveryTraceScenario({
      scenario: {
        name: `feishu-visible-tts-${voice.audioAsVoice ? "explicit" : "inferred"}`,
        steps: [{ kind: "final", text: "Already-visible TTS answer" }],
      },
      setup: (recorder) => {
        setupFeishuTrace(recorder, "final-only");
        traceState.loadedMedia = {
          buffer: Buffer.from("%PDF-1.7 trace document"),
          fileName: "report.pdf",
          contentType: "application/pdf",
        };
        traceState.account = {
          ...makeTraceAccount("final-only"),
          config: FeishuConfigSchema.parse({ renderMode: "raw", streaming: { mode: "off" } }),
        };
        const dispatcher = createFeishuReplyDispatcher({
          cfg: {} as never,
          agentId: "agent",
          runtime: {} as never,
          chatId: "oc-trace-chat",
          sendTarget: "oc-trace-chat",
        });
        return async (step) => {
          if (step.kind !== "final") {
            throw new Error("unexpected visible-TTS trace step");
          }
          await dispatcher.delivery.deliver(
            {
              text: step.text,
              mediaUrl: "https://example.com/download.ogg",
              ...(voice.audioAsVoice ? { audioAsVoice: true } : {}),
              ttsSupplement: {
                spokenText: step.text ?? "",
                visibleTextAlreadyDelivered: true,
              },
            },
            { kind: "final" },
          );
        };
      },
    });

    const sends = events.filter((event) => event.kind === "im.message.create");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ data: { payload: { msg_type: "file" } } });
  });

  for (const scenarioName of FEISHU_TRACE_SCENARIOS) {
    it(`records ${scenarioName}`, async () => {
      const events = await runDeliveryTraceScenario({
        scenario: deliveryTraceScenarios[scenarioName],
        setup: (recorder) => setupFeishuTrace(recorder, scenarioName),
      });
      expectDeliveryTraceMatchesGolden({
        goldenUrl: new URL(`./__traces__/${scenarioName}.trace.jsonl`, import.meta.url),
        events,
      });
    });
  }
});
