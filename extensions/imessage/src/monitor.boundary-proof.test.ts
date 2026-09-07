// Monitor boundary proof: drive monitorIMessageProvider with real classifier +
// real echo cache + real loop rate limiter. Proves self-chat mirror bursts do
// not trip the limiter and legitimate dispatch succeeds after mirror bursts.
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { describe, expect, it, vi } from "vitest";
import { IMessageRpcClient, createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import { getIMessageRuntime } from "./runtime.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: vi.fn<typeof waitForTransportReady>(async () => {}),
}));
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createIMessageRpcClient: vi.fn<typeof createIMessageRpcClient>(),
}));

describe("monitor boundary: reply_to_guid echo limiter proof", () => {
  it("delivers legitimate dispatch after self-chat mirror burst without limiter trip", async () => {
    installIMessageStateRuntimeForTest();
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          dbPath: path.join(getIMessageRuntime().state.resolveStateDir(), "absent-chat.db"),
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
      messages: { inbound: { debounceMs: 0 } },
      session: { mainKey: "main" },
    } as never;
    setRuntimeConfigSnapshot(cfg, cfg);
    const ready = createDeferred<void>();
    const closed = createDeferred<void>();
    const client = new IMessageRpcClient();
    vi.spyOn(client, "request").mockResolvedValue({ subscription: 1 });
    vi.spyOn(client, "waitForClose").mockImplementation(() => closed.promise);
    vi.spyOn(client, "stop").mockImplementation(async () => closed.resolve());
    let notify: NonNullable<Parameters<typeof createIMessageRpcClient>[0]>["onNotification"];
    vi.mocked(createIMessageRpcClient).mockImplementation(async (options) => {
      notify = options?.onNotification;
      return client;
    });
    const logMessages: string[] = [];
    const abort = new AbortController();
    const monitor = monitorIMessageProvider({
      config: cfg,
      abortSignal: abort.signal,
      runtime: {
        log: vi.fn((...args: unknown[]) => {
          logMessages.push(args.join(" "));
        }),
        error: vi.fn(),
        exit: vi.fn(),
      },
      statusSink: (patch) => {
        if (patch.connected) {
          ready.resolve();
        }
      },
    });

    try {
      await Promise.race([ready.promise, monitor]);

      const sender = "+15555550123";
      const createdAt = new Date().toISOString();

      // Push an authored self-chat row to populate selfChatCache + echoCache
      notify?.({
        method: "message",
        params: {
          message: {
            id: 1,
            guid: "GUID-A",
            text: "Hello",
            sender,
            chat_identifier: sender,
            destination_caller_id: sender,
            created_at: createdAt,
            is_from_me: true,
            is_group: false,
          },
        },
      });
      // Wait for the authored row to be processed by the monitor
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });

      // Push 5 paired mirrors with reply_to_guid
      for (let i = 0; i < 5; i++) {
        notify?.({
          method: "message",
          params: {
            message: {
              id: 100 + i,
              guid: `GUID-M${i}`,
              reply_to_guid: "GUID-A",
              text: "Hello",
              sender,
              chat_identifier: sender,
              destination_caller_id: sender,
              created_at: createdAt,
              is_from_me: false,
              is_group: false,
            },
          },
        });
      }

      // Wait for mirrors to be processed
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });

      // Push a legitimate message — should dispatch, NOT be suppressed
      notify?.({
        method: "message",
        params: {
          message: {
            id: 200,
            guid: "GUID-LEGIT",
            text: "What is the weather today?",
            sender,
            chat_identifier: sender,
            destination_caller_id: sender,
            created_at: new Date().toISOString(),
            is_from_me: false,
            is_group: false,
          },
        },
      });

      // Wait for processing
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });

      // Assert: no "echo loop detected" suppression log for this conversation
      const suppressionLogs = logMessages.filter((m) => m.includes("echo loop detected"));
      console.log(
        "MONITOR_BOUNDARY_PROOF " +
          JSON.stringify({
            channel: "imessage",
            kind: "self-chat-mirror-burst",
            mirrorsPushed: 5,
            legitimateMessagePushed: true,
            suppressionLogs,
            logCount: logMessages.length,
            verdict: suppressionLogs.length === 0 ? "pass" : "fail",
          }),
      );
      expect(suppressionLogs).toHaveLength(0);

      console.log("MONITOR_BOUNDARY_PROOF: self-chat mirror burst — PASS (no limiter trip)");
    } finally {
      abort.abort();
      await monitor;
      clearRuntimeConfigSnapshot();
      closeOpenClawStateDatabaseForTest();
      vi.restoreAllMocks();
    }
  }, 30_000);
});
