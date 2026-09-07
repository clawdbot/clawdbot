import fs from "node:fs/promises";
import path from "node:path";
import type { WebClient } from "@slack/web-api";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import {
  buildChannelInboundEventContext,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  createChannelIngressQueueForTests,
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSlackRuntime } from "./runtime.js";

// Match the maintained monitor fixture's Bolt surface without replacing config,
// dispatch, media loading, or filesystem reads.
const provider = vi.hoisted(() => ({
  handlers: new Map<string, (args: Record<string, unknown>) => Promise<void>>(),
  onStart: () => {},
  uploaded: [] as Buffer[],
  client: {
    auth: {
      test: vi.fn(async () => ({
        app_id: "A_ENTERPRISE",
        user_id: "UENTERPRISE",
        bot_id: "BENTERPRISE",
        enterprise_id: "E_ENTERPRISE",
        is_enterprise_install: true,
      })),
    },
    conversations: {
      info: vi.fn(async () => ({ channel: { name: "general", is_channel: true } })),
      replies: vi.fn(async () => ({ messages: [] })),
      history: vi.fn(async () => ({ messages: [] })),
    },
    users: { info: vi.fn(async () => ({ user: { profile: { display_name: "Fixture" } } })) },
    reactions: {
      add: vi.fn(async () => ({ ok: true })),
      remove: vi.fn(async () => ({ ok: true })),
    },
    chat: { postMessage: vi.fn(async () => ({ ok: true, ts: "123.456", channel: "C12345678" })) },
    files: {
      getUploadURLExternal: vi.fn(async () => ({
        ok: true,
        upload_url: "https://files.slack.com/upload",
        file_id: "F123",
      })),
      completeUploadExternal: vi.fn(async () => ({ ok: true })),
    },
  },
}));

vi.mock("@slack/bolt", () => {
  type Middleware = (
    args: Record<string, unknown> & { next: () => Promise<void> },
  ) => Promise<void>;
  class App {
    client = provider.client;
    receiver: unknown;
    middlewares: Middleware[] = [];
    constructor(options: { receiver?: unknown }) {
      this.receiver = options.receiver;
    }
    use(middleware: Middleware) {
      this.middlewares.push(middleware);
    }
    event(name: string, handler: (args: Record<string, unknown>) => Promise<void>) {
      provider.handlers.set(name, async (args) => {
        const next = async (index: number): Promise<void> => {
          const middleware = this.middlewares[index];
          if (middleware) {
            await middleware({ ...args, next: () => next(index + 1) });
          } else {
            await handler(args);
          }
        };
        await next(0);
      });
    }
    command() {}
    action() {}
    shortcut() {}
    view() {}
    async start() {
      provider.onStart();
    }
    async stop() {}
  }
  class SocketModeReceiver {
    client = { on: vi.fn(), off: vi.fn() };
  }
  function HTTPReceiver() {}
  return {
    App,
    SocketModeReceiver,
    HTTPReceiver,
    default: { App, SocketModeReceiver, HTTPReceiver },
  };
});
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createSlackStartupAuthClient: () => provider.client,
  getSlackListenerWriteClient: () => provider.client,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (request: Parameters<typeof actual.fetchWithSsrFGuard>[0]) => {
      expect(request.url).toBe("https://files.slack.com/upload");
      provider.uploaded.push(Buffer.from(request.init?.body as Uint8Array));
      return { response: new Response(null, { status: 200 }), release: async () => {} };
    },
  };
});

const { sendMessageSlack } = await import("./send.js");
const { monitorSlackProvider } = await import("./monitor/provider.js");
const { clearRuntime } = createPluginRuntimeStore({
  pluginId: "slack",
  errorMessage: "Slack runtime not initialized",
});

beforeEach(() => {
  provider.handlers.clear();
  provider.uploaded.length = 0;
  vi.clearAllMocks();
});

describe("Slack configured limits on real local files", () => {
  it.each([
    { label: "fractional channel cap", mediaMaxMb: 0.001, size: 1048, accepted: true },
    { label: "next byte above the cap", mediaMaxMb: 0.001, size: 1049, accepted: false },
    { label: "sub-byte cap", mediaMaxMb: 0.1 / (1024 * 1024), size: 1, accepted: false },
    {
      label: "explicit byte override",
      mediaMaxMb: 0.1 / (1024 * 1024),
      maxBytes: 1048,
      size: 1048,
      accepted: true,
    },
    { label: "explicit zero override", mediaMaxMb: 30.1, maxBytes: 0, size: 1048, accepted: false },
    {
      label: "invalid byte override fallback",
      mediaMaxMb: 0.001,
      maxBytes: Number.POSITIVE_INFINITY,
      size: 1049,
      accepted: false,
    },
    { label: "agent fallback cap", mediaMaxMb: undefined, size: 1048, accepted: false },
  ])("preserves the sender's $label", async (testCase) => {
    const state = await createOpenClawTestState({ label: "slack-send-limit" });
    try {
      const document = Buffer.alloc(testCase.size, 0x61);
      document.write("%PDF-1.4\n");
      const mediaPath = path.join(state.workspaceDir, "limit.pdf");
      await fs.writeFile(mediaPath, document);
      const client = provider.client as unknown as WebClient;
      const sending = sendMessageSlack("channel:C12345678", "document", {
        cfg: {
          agents: { defaults: { mediaMaxMb: 0.1 / (1024 * 1024) } },
          channels: { slack: { mediaMaxMb: testCase.mediaMaxMb } },
        },
        eventScope: { teamId: "TWORKSPACE", client, writeClient: client },
        mediaUrl: mediaPath,
        mediaLocalRoots: [state.workspaceDir],
        forceDocument: true,
        ...("maxBytes" in testCase ? { mediaMaxBytes: testCase.maxBytes } : {}),
      });
      if (!testCase.accepted) {
        await expect(sending).rejects.toThrow(/exceeds|too large/i);
        expect(provider.client.files.getUploadURLExternal).not.toHaveBeenCalled();
        expect(provider.uploaded).toHaveLength(0);
        return;
      }
      await sending;
      expect(provider.uploaded).toEqual([document]);
      expect(provider.client.files.completeUploadExternal).toHaveBeenCalledTimes(1);
    } finally {
      await state.cleanup();
    }
  });

  it.each([
    { mediaMaxMb: 30.1, override: undefined, agentMediaMaxMb: undefined, accepted: true },
    {
      mediaMaxMb: 0.1 / (1024 * 1024),
      override: 30.1,
      agentMediaMaxMb: undefined,
      accepted: true,
    },
    {
      mediaMaxMb: undefined,
      override: undefined,
      agentMediaMaxMb: 0.1 / (1024 * 1024),
      accepted: false,
    },
    {
      mediaMaxMb: undefined,
      override: Number.POSITIVE_INFINITY,
      agentMediaMaxMb: 0.1 / (1024 * 1024),
      accepted: false,
    },
    { mediaMaxMb: undefined, override: undefined, agentMediaMaxMb: undefined, accepted: true },
  ])(
    "carries the monitor-selected limit ($mediaMaxMb, $override, $agentMediaMaxMb) to an Enterprise upload",
    async (testCase) => {
      const state = await createOpenClawTestState({ label: "slack-monitor-limit" });
      const abort = new AbortController();
      let running: Promise<unknown> | undefined;
      try {
        const document = Buffer.from("%PDF-1.4\nmonitor media budget\n%%EOF\n");
        const mediaPath = state.statePath("media", "limit.pdf");
        await fs.mkdir(path.dirname(mediaPath), { recursive: true });
        await fs.writeFile(mediaPath, document);
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              mediaMaxMb: testCase.agentMediaMaxMb,
            },
          },
          commands: { native: false, nativeSkills: false },
          channels: {
            slack: {
              mediaMaxMb: testCase.mediaMaxMb,
              dmPolicy: "disabled",
              groupPolicy: "open",
              channels: {
                "team:TWORKSPACE:channel:C12345678": { requireMention: true },
              },
            },
          },
        };
        await state.writeConfig(cfg);
        type SlackRuntime = Parameters<typeof setSlackRuntime>[0];
        setSlackRuntime({
          state: {
            resolveStateDir: () => state.stateDir,
            openKeyedStore: ((options) =>
              createPluginStateKeyedStoreForTests(
                "slack",
                options,
              )) as SlackRuntime["state"]["openKeyedStore"],
            openSyncKeyedStore: ((options) =>
              createPluginStateSyncKeyedStoreForTests(
                "slack",
                options,
              )) as SlackRuntime["state"]["openSyncKeyedStore"],
            openChannelIngressQueue: ((options) =>
              createChannelIngressQueueForTests({
                ...options,
                channelId: "slack",
                stateDir: state.stateDir,
              })) as SlackRuntime["state"]["openChannelIngressQueue"],
          },
          channel: {},
        } as SlackRuntime);
        const dispatch = vi.fn<NonNullable<ChannelInboundTurnPlan["dispatchReplyFromConfig"]>>(
          async ({ dispatcher }) => {
            const queuedFinal = dispatcher.sendFinalReply({ mediaUrl: mediaPath });
            return { queuedFinal, counts: dispatcher.getQueuedCounts() };
          },
        );
        const startup: { outcome?: { ok: true } | { ok: false; error: unknown } } = {};
        provider.onStart = () => {
          startup.outcome ??= { ok: true };
        };
        running = monitorSlackProvider({
          config: cfg,
          botToken: "xoxb-test",
          appToken: "xapp-test",
          abortSignal: abort.signal,
          mediaMaxMb: testCase.override,
          channelRuntime: {
            inbound: { buildContext: buildChannelInboundEventContext },
            reply: { dispatchReplyFromConfig: dispatch },
          } as unknown as ChannelRuntimeSurface,
        });
        void running.then(
          () => {
            startup.outcome ??= {
              ok: false,
              error: new Error("Slack monitor exited before startup"),
            };
          },
          (error: unknown) => {
            startup.outcome = { ok: false, error };
          },
        );
        await vi.waitFor(() => {
          expect(startup.outcome, "Slack startup to settle").toBeDefined();
        });
        const startupOutcome = expectDefined(startup.outcome, "Slack startup outcome");
        if (!startupOutcome.ok) {
          throw startupOutcome.error;
        }
        const handler = provider.handlers.get("message");
        if (!handler) {
          throw new Error("Slack message handler was not registered");
        }
        // The maintained monitor fixture uses this admitted lifecycle to await the turn,
        // rather than returning after background queue admission.
        const handling = handler({
          event: {
            type: "message",
            user: "UOTHER123",
            text: "<@UENTERPRISE> send the document",
            ts: "999999.123",
            channel: "C12345678",
            channel_type: "channel",
          },
          context: {
            isEnterpriseInstall: true,
            enterpriseId: "E_ENTERPRISE",
            teamId: "TWORKSPACE",
            openclawIngressLifecycle: {
              admission: "exclusive",
              abortSignal: abort.signal,
              onAdopted: async () => {},
              onDeferred: () => {},
              onAbandoned: async () => {},
            },
          },
          body: { api_app_id: "A_ENTERPRISE" },
          client: provider.client,
        });
        if (testCase.accepted) {
          await handling;
        } else {
          await expect(handling).rejects.toThrow(/exceeds.*limit/i);
        }
        expect(dispatch).toHaveBeenCalledTimes(1);
        if (!testCase.accepted) {
          expect(provider.uploaded).toEqual([]);
          expect(provider.client.files.completeUploadExternal).not.toHaveBeenCalled();
          return;
        }
        expect(provider.uploaded).toEqual([document]);
        expect(provider.client.files.completeUploadExternal).toHaveBeenCalledWith(
          expect.objectContaining({ channel_id: "C12345678" }),
        );
      } finally {
        abort.abort();
        try {
          await running;
        } finally {
          resetPluginStateStoreForTests();
          clearRuntime();
          await state.cleanup();
        }
      }
    },
  );
});
