/**
 * Source-runtime proof of bot-budget replay identity across real adapter retries.
 * Run: node --import ./scripts/tsx.mjs scripts/proof-117734-conversation-burst-replay.ts
 *
 * Real: Feishu receive/debounce/replay claims/bot admission; Google Chat monitor,
 * SQLite ingress queue/drain/adoption; both shared loop guards and access policies.
 * Edge fixture: the final inbound turn runner records adoption instead of invoking
 * a model, with one pre-adoption transport failure. Google events enter the durable
 * queue after the HTTP authentication boundary; no JWT verification is claimed.
 * No module interception, Vitest, credentials, public requests, or live state.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import type { FeishuMessageEvent } from "../extensions/feishu/src/event-types.js";
import type { GoogleChatEvent } from "../extensions/googlechat/src/types.js";
import type { OpenClawConfig } from "../src/config/types.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";

const heartbeat = new Worker(
  'setInterval(() => process.stdout.write("proof-117734: source runtime still active\\n"), 30000)',
  { eval: true },
);
const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-proof-117734-"));
// Set before loading application modules. Nothing reads the operator's config/state.
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "absent-config.json");
process.env.OPENCLAW_SKIP_CHANNELS = "1";
let assertions = 0;
function check(condition: unknown, message: string) {
  assert.ok(condition, message);
  assertions++;
  console.log(`ok ${assertions}: ${message}`);
}
async function until(condition: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, `deadline waiting for ${label}`);
    await delay(25);
  }
}

try {
  const [
    runtimeModule,
    snapshot,
    receiveModule,
    botModule,
    feishuRuntime,
    dedupe,
    googleMonitor,
    googleRuntime,
    queueModule,
    registryModule,
    httpRegistry,
  ] = await Promise.all([
    import("../src/plugins/runtime/index.js"),
    import("../src/config/runtime-snapshot.js"),
    import("../extensions/feishu/src/monitor.message-handler.js"),
    import("../extensions/feishu/src/bot.js"),
    import("../extensions/feishu/src/runtime.js"),
    import("../extensions/feishu/src/dedup.js"),
    import("../extensions/googlechat/src/monitor.js"),
    import("../extensions/googlechat/src/runtime.js"),
    import("../src/channels/message/ingress-queue.js"),
    import("../src/plugins/registry-empty.js"),
    import("../src/plugins/http-registry.js"),
  ]);

  function config(channel: "feishu" | "googlechat", disabled: boolean): OpenClawConfig {
    return {
      agents: { defaults: { workspace: path.join(stateDir, "workspace") } },
      channels: {
        defaults: {
          groupPolicy: "open",
          botLoopProtection: {
            maxEventsPerWindow: 100,
            ...(disabled ? {} : { maxConversationBotEvents: 4 }),
            windowSeconds: 60,
            cooldownSeconds: 60,
          },
        },
        [channel]:
          channel === "feishu"
            ? {
                enabled: true,
                allowBots: true,
                groupPolicy: "open",
                resolveSenderNames: false,
                typingIndicator: false,
                streaming: false,
                groups: { "*": { requireMention: false } },
              }
            : {
                enabled: true,
                allowBots: true,
                groupPolicy: "open",
                botUser: "users/app",
                typingIndicator: "none",
                groups: { "*": { requireMention: false } },
              },
      },
    };
  }

  function recordingRuntime(completed: string[], attempts: Map<string, number>) {
    const core = runtimeModule.createPluginRuntime();
    // This is the downstream turn-dispatch edge, not an adapter/guard replacement.
    // Inspect the real adapter plan to use the exact forwarded adoption lifecycle.
    core.channel.inbound.run = async (params) => {
      const input = await params.adapter.ingest(params.raw);
      assert.ok(input, "real adapter must produce normalized input");
      const count = (attempts.get(input.id) ?? 0) + 1;
      attempts.set(input.id, count);
      if (input.id.endsWith("b1") && count === 1) {
        throw new Error("proof fixture: transient pre-adoption turn transport failure");
      }
      const plan = await params.adapter.resolveTurn(
        input,
        { kind: "message", canStartAgentTurn: true },
        {},
      );
      const lifecycle =
        params.turnAdoptionLifecycle ??
        ("replyOptions" in plan ? plan.replyOptions?.turnAdoptionLifecycle : undefined);
      assert.ok(lifecycle, "adapter must forward its real ingress adoption lifecycle");
      await lifecycle.onAdopted();
      completed.push(input.id);
      return {
        admission: { kind: "handled", reason: "proof turn edge adopted" },
        dispatched: false,
      };
    };
    return core;
  }

  async function feishuScenario(disabled: boolean) {
    const label = disabled ? "disabled" : "enabled";
    const cfg = config("feishu", disabled);
    snapshot.setRuntimeConfigSnapshot(cfg);
    const completed: string[] = [];
    const attempts = new Map<string, number>();
    const core = recordingRuntime(completed, attempts);
    feishuRuntime.setFeishuRuntime(core);
    let drain = async () => {};
    const channelRuntime: PluginRuntime["channel"] = {
      ...core.channel,
      debounce: {
        ...core.channel.debounce,
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: (options) => {
          const debouncer = core.channel.debounce.createInboundDebouncer(options);
          drain = debouncer.drain;
          return debouncer;
        },
      },
    };
    let abandoned = 0;
    const accountId = `proof-feishu-${label}`;
    const chatId = `oc-proof-${label}`;
    const errors: string[] = [];
    const receive = receiveModule.createFeishuMessageReceiveHandler({
      cfg,
      accountId,
      channelRuntime,
      chatHistories: new Map(),
      runtime: {
        log: () => {},
        error: (message) => errors.push(String(message)),
        exit: (code) => {
          throw new Error(`unexpected runtime exit ${code}`);
        },
      },
      handleMessage: botModule.handleFeishuMessage,
      getBotOpenId: () => "ou-proof-self",
      resolveDebounceText: ({ event }) => event.message.content,
      hasProcessedMessage: dedupe.hasProcessedFeishuMessage,
      resolveIngressLifecycle: () => ({
        abortSignal: new AbortController().signal,
        onAdopted: async () => {},
        onDeferred: () => {},
        onAdoptionFinalizing: () => {},
        onAbandoned: () => {
          abandoned++;
        },
      }),
    });
    const send = async (id: string, sender: string) => {
      const event: FeishuMessageEvent = {
        sender: { sender_id: { open_id: sender }, sender_type: "bot" },
        message: {
          message_id: `${label}-${id}`,
          chat_id: chatId,
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: `@_proof ${id}` }),
          mentions: [{ key: "@_proof", id: { open_id: "ou-proof-self" }, name: "OpenClaw" }],
        },
      };
      await receive(event);
      await drain();
    };
    await send("a1", "ou-proof-a");
    await send("a2", "ou-proof-a");
    await send("b1", "ou-proof-b");
    check(
      completed.length === 2 && abandoned > 0,
      `Feishu ${label}: real abandonment before adoption`,
    );
    check(
      errors.some((line) => line.includes("transient pre-adoption")),
      "Feishu injected failure reached real receive lifecycle",
    );
    await send("b1", "ou-proof-b");
    check(
      attempts.get(`${label}-b1`) === 2,
      `Feishu ${label}: released replay claim permits retry`,
    );
    await send("b2", "ou-proof-b");
    assert.deepEqual(
      completed,
      ["a1", "a2", "b1", "b2"].map((id) => `${label}-${id}`),
    );
    check(
      completed.length === 4,
      `Feishu ${label}: retry does not consume fourth unique admission`,
    );
    await send("b3", "ou-proof-b");
    check(
      completed.length === (disabled ? 5 : 4),
      `Feishu ${label}: fifth unique event ${disabled ? "admitted" : "suppressed"}`,
    );
  }

  async function googleScenario(disabled: boolean) {
    const label = disabled ? "disabled" : "enabled";
    const cfg = config("googlechat", disabled);
    snapshot.setRuntimeConfigSnapshot(cfg);
    const completed: string[] = [];
    const attempts = new Map<string, number>();
    const core = recordingRuntime(completed, attempts);
    const accountId = `proof-google-${label}`;
    const space = `spaces/PROOF-${label}`;
    core.state.openChannelIngressQueue = (options) =>
      queueModule.createChannelIngressQueue({
        ...options,
        channelId: "googlechat",
        stateDir,
      });
    googleRuntime.setGoogleChatRuntime(core);
    const queue = queueModule.createChannelIngressQueue<{ version: 1; rawEvent: string }>({
      channelId: "googlechat",
      accountId,
      stateDir,
    });
    const abort = new AbortController();
    const errors: string[] = [];
    const stop = await httpRegistry.withPluginHttpRouteRegistry(
      registryModule.createEmptyPluginRegistry(),
      () =>
        googleMonitor.startGoogleChatMonitor({
          account: {
            accountId,
            enabled: true,
            credentialSource: "none",
            config: {
              allowBots: true,
              groupPolicy: "open",
              botUser: "users/app",
              typingIndicator: "none",
              groups: { "*": { requireMention: false } },
              audienceType: "app-url",
              audience: "https://proof.invalid/googlechat",
            },
          },
          config: cfg,
          abortSignal: abort.signal,
          runtime: { log: () => {}, error: (message) => errors.push(message) },
        }),
    );
    try {
      const send = async (id: string, sender: string) => {
        const event: GoogleChatEvent = {
          type: "MESSAGE",
          eventTime: new Date().toISOString(),
          space: { name: space, type: "SPACE" },
          message: {
            name: `${space}/messages/${id}`,
            text: id,
            sender: { name: sender, type: "BOT" },
          },
        };
        const payload = { version: 1 as const, rawEvent: JSON.stringify(event) };
        const fullId = `${space}/messages/${id}`;
        const receipt = await queue.enqueue(fullId, payload, { laneKey: `space:${space}` });
        assert.equal(receipt.kind, "accepted");
        // Production monitor's poll/drain owns retry timing, claims, and completion.
        await until(
          async () => (await queue.enqueue(fullId, payload)).kind === "completed",
          fullId,
        );
      };
      await send("a1", "users/proof-a");
      await send("a2", "users/proof-a");
      await send("b1", "users/proof-b");
      check(
        attempts.get(`${space}/messages/b1`) === 2,
        `Google Chat ${label}: durable drain retries same unadopted message`,
      );
      check(
        errors.some((line) => line.includes("transient pre-adoption")),
        "Google Chat injected failure reached real durable retry policy",
      );
      await send("b2", "users/proof-b");
      assert.deepEqual(
        completed,
        ["a1", "a2", "b1", "b2"].map((id) => `${space}/messages/${id}`),
      );
      check(
        completed.length === 4,
        `Google Chat ${label}: retry does not consume fourth unique admission`,
      );
      await send("b3", "users/proof-b");
      check(
        completed.length === (disabled ? 5 : 4),
        `Google Chat ${label}: fifth unique event ${disabled ? "admitted" : "suppressed"}`,
      );
      check(
        (await queue.listFailed?.())?.length === 0,
        "Google Chat has no hidden dead-letter failure",
      );
    } finally {
      abort.abort();
      await stop();
    }
  }

  const adapter = process.argv.find((arg) => arg.startsWith("--adapter="))?.slice(10) ?? "both";
  assert.ok(["both", "feishu", "googlechat"].includes(adapter), "unknown adapter selector");
  if (adapter !== "googlechat") {
    await feishuScenario(false);
    await feishuScenario(true);
  }
  if (adapter !== "feishu") {
    await googleScenario(false);
    await googleScenario(true);
  }
  console.log(`All ${assertions} runtime assertions passed.`);
} finally {
  await heartbeat.terminate();
  await rm(stateDir, { recursive: true, force: true });
}
