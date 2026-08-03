// Imessage tests cover monitor.plugin payload plugin behavior.
import path from "node:path";
import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import {
  addTestHook,
  createEmptyPluginRegistry,
  createTestInboundDebounceFlush,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import type { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import { setCachedIMessagePrivateApiStatus } from "./private-api-status.js";
import { getIMessageRuntime } from "./runtime.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const shouldDebounceTextInboundMock = vi.hoisted(() => vi.fn(() => false));
const directDeliveryProof = vi.hoisted(() => ({ flush: false }));

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    createChannelInboundDebouncer: vi.fn(
      (opts: {
        shouldDebounce: (entry: unknown) => boolean;
        onFlush: (
          entries: unknown[],
          createFlush: typeof createTestInboundDebounceFlush,
        ) => { completion: Promise<void> };
      }) => ({
        debouncer: {
          enqueue: async (entry: unknown) => {
            opts.shouldDebounce(entry);
            if (directDeliveryProof.flush) {
              await opts.onFlush([entry], createTestInboundDebounceFlush).completion;
            }
          },
        },
      }),
    ),
    shouldDebounceTextInbound: shouldDebounceTextInboundMock,
  };
});

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: vi.fn(() => () => {}),
}));

describe("iMessage plugin payload attachments", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createIMessageRpcClientMock.mockReset();
    shouldDebounceTextInboundMock.mockReset().mockReturnValue(false);
    directDeliveryProof.flush = false;
  });

  afterEach(() => {
    resetGlobalHookRunner();
    vi.restoreAllMocks();
  });

  it("does not count Apple rich-link plugin payloads as user media", async () => {
    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 1,
              guid: "plugin-payload-guid-1",
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "https://example.com/article",
              attachments: [
                {
                  original_path:
                    "/Users/openclaw/Library/Messages/Attachments/AA/BB/link.pluginPayloadAttachment",
                  mime_type: null,
                  missing: false,
                  transfer_name: "link.pluginPayloadAttachment",
                  uti: "com.apple.messages.pluginPayloadAttachment",
                },
              ],
              is_group: false,
            },
          },
        });
        await Promise.resolve();
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (!params?.onNotification) {
        throw new Error("expected iMessage notification handler");
      }
      onNotification = params.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: { imessage: { includeAttachments: true, dmPolicy: "open" } },
        session: { mainKey: "main" },
      } as never,
    });

    expect(shouldDebounceTextInboundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "https://example.com/article",
        hasMedia: false,
      }),
    );
  });

  it.each([
    { kind: "tool", text: "provider-visible tool result", visible: true },
    { kind: "block", text: "provider-visible streamed block", visible: true },
    { kind: "tool", text: "<thinking>private reasoning</thinking>", visible: false },
  ] as const)(
    "settles direct $kind delivery through actual provider, hooks, and SQLite ($visible)",
    async ({ kind, text, visible }) => {
      directDeliveryProof.flush = true;
      const messageSent = vi.fn();
      const registry = createEmptyPluginRegistry();
      addTestHook({
        registry,
        pluginId: "imessage-monitor-proof",
        hookName: "message_sent",
        handler: messageSent,
      });
      initializeGlobalHookRunner(registry);
      setCachedIMessagePrivateApiStatus("imsg", {
        available: true,
        v2Ready: true,
        selectors: {},
        rpcMethods: ["watch.subscribe", "send"],
      });

      const dispatch = vi.fn<typeof dispatchReplyWithBufferedBlockDispatcher>(async (params) => {
        const settled = await params.dispatcherOptions.deliver({ text }, { kind });
        expect(settled).toMatchObject(
          visible
            ? {
                visibleReplySent: true,
                messageIds: [`native-${kind}-guid`],
                receipt: { platformMessageIds: [`native-${kind}-guid`] },
                content: text,
              }
            : { visibleReplySent: false, suppression: { reason: "no_visible_result" } },
        );
        return {
          queuedFinal: false,
          counts: { tool: kind === "tool" ? 1 : 0, block: kind === "block" ? 1 : 0, final: 0 },
        };
      });
      const runActual = channelInbound.runChannelInboundEvent;
      vi.spyOn(channelInbound, "runChannelInboundEvent").mockImplementation(async (params) =>
        runActual({
          ...params,
          adapter: {
            ...params.adapter,
            resolveTurn: async (input, eventClass, preflight) => {
              const turn = await params.adapter.resolveTurn(input, eventClass, preflight);
              if (!("route" in turn) || !("delivery" in turn)) {
                throw new Error("expected assembled iMessage delivery turn");
              }
              const { route, ...resolvedTurn } = turn;
              return {
                ...resolvedTurn,
                agentId: route.agentId,
                routeSessionKey: route.sessionKey,
                storePath: resolveStorePath(turn.cfg.session?.store, { agentId: route.agentId }),
                recordInboundSession,
                dispatchReplyWithBufferedBlockDispatcher: dispatch,
              };
            },
          },
        }),
      );

      const nativeClient = {
        request: vi.fn(async (method: string) => {
          if (method !== "send") {
            throw new Error(`unexpected native iMessage method ${method}`);
          }
          return { guid: `native-${kind}-guid`, status: "sent" };
        }),
        stop: vi.fn(async () => {}),
      };
      let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
      const watchClient = {
        request: vi.fn(async () => ({ subscription: 1 })),
        waitForClose: vi.fn(async () => {
          onNotification?.({
            method: "message",
            params: {
              message: {
                id: 91,
                guid: `monitor-${kind}-${visible}-guid`,
                chat_id: 123,
                sender: "+15550001111",
                is_from_me: false,
                text: "exercise actual direct delivery",
                is_group: false,
                created_at: new Date().toISOString(),
              },
            },
          });
          await Promise.resolve();
          await Promise.resolve();
        }),
        stop: vi.fn(async () => {}),
      };
      createIMessageRpcClientMock.mockImplementation(async (params) => {
        if (params?.onNotification) {
          onNotification = params.onNotification;
          return watchClient as never;
        }
        return nativeClient as never;
      });

      await monitorIMessageProvider({
        config: {
          channels: {
            imessage: {
              dmPolicy: "allowlist",
              allowFrom: ["+15550001111"],
              sendReadReceipts: false,
            },
          },
          messages: { inbound: { debounceMs: 0 } },
          session: { mainKey: "main" },
        } as never,
        runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
      });

      if (!visible) {
        expect(nativeClient.request).not.toHaveBeenCalled();
        expect(messageSent).not.toHaveBeenCalled();
        return;
      }
      await vi.waitFor(() => {
        expect(messageSent).toHaveBeenCalledOnce();
      });
      expect(messageSent).toHaveBeenCalledWith(
        expect.objectContaining({ content: text, success: true, messageId: `native-${kind}-guid` }),
        expect.objectContaining({ channelId: "imessage" }),
      );

      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(
        path.join(getIMessageRuntime().state.resolveStateDir(), "state", "openclaw.sqlite"),
        { readOnly: true },
      );
      try {
        const persisted = database
          .prepare(
            "SELECT value_json FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ?",
          )
          .all("imessage", "imessage.sent-echoes");
        expect(persisted).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ value_json: expect.stringContaining(`native-${kind}-guid`) }),
          ]),
        );
      } finally {
        database.close();
      }
    },
  );
});
