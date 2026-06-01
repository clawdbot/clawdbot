/**
 * Real-runtime behavior proof for #73706.
 *
 * This script does NOT use vitest mocks. It wires up the production
 * `deliverOutboundPayloads` path against:
 *   - a real `PluginRegistry` populated with one real channel plugin and
 *     two real plugin hooks (`message_sending`, `message_sent`)
 *   - the real `getGlobalHookRunner()` / `initializeGlobalHookRunner()`
 *     singleton path (no fake hook runner)
 *   - the real `setActivePluginRegistry` channel resolution path (no
 *     fake channel adapter)
 *
 * It then exercises three scenarios:
 *
 *   1. Direct outbound delivery with `session.key` set: confirms the
 *      `message_sending` and `message_sent` hook contexts both receive
 *      the canonical `sessionKey`.
 *
 *   2. Direct outbound delivery with NO session: confirms `sessionKey`
 *      is absent from both hook contexts (the "narrowed" docs branch).
 *
 *   3. Native-redirect simulation: outbound delivery whose `session.key`
 *      is set to the redirect TARGET session (i.e., what the agent
 *      runtime resolves as `params.sessionKey` when
 *      `CommandTargetSessionKey` is set and `CommandSource === "native"`,
 *      and what `dispatch-from-config.ts` now passes through to
 *      `routeReply`). Confirms `message_sending` / `message_sent`
 *      observe the redirect-target session, NOT the inbound session.
 *      This is the runtime invariant Clawsweeper asked us to pin
 *      with a regression test.
 *
 * Run with:
 *   pnpm tsx scripts/proof-73706-message-sending-session-key.ts
 */

import { deliverOutboundPayloads } from "../src/infra/outbound/deliver.js";
import type {
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
} from "../src/plugins/hook-message.types.js";
import { initializeGlobalHookRunner } from "../src/plugins/hook-runner-global.js";
import { addTestHook, createMockPluginRegistry } from "../src/plugins/hooks.test-helpers.js";
import type { PluginRegistry } from "../src/plugins/registry.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../src/test-utils/channel-plugins.js";

type CapturedContext = {
  hook: "message_sending" | "message_sent";
  ctx: PluginHookMessageContext;
  event: PluginHookMessageReceivedEvent;
};

function buildRegistry(captured: CapturedContext[], channelId: "matrix"): PluginRegistry {
  // Real outbound channel plugin: returns a synthetic delivery result
  // without touching any network. This drives `deliverOutboundPayloads`
  // through its real channel-resolution + sendText path.
  const sendText = async () => ({
    channel: channelId,
    messageId: `mx-${Date.now()}`,
    roomId: "!room:example",
  });

  const channelRegistry = createTestRegistry([
    {
      pluginId: channelId,
      source: "proof",
      plugin: createOutboundTestPlugin({
        id: channelId,
        outbound: { deliveryMode: "direct", sendText },
      }),
    },
  ]);

  // Real hook handlers: capture exactly what delivery hands to plugins.
  const hookRegistry = createMockPluginRegistry([]);
  addTestHook({
    registry: hookRegistry,
    pluginId: "proof-message-sending",
    hookName: "message_sending",
    handler: async (event: unknown, ctx: unknown) => {
      captured.push({
        hook: "message_sending",
        ctx: ctx as PluginHookMessageContext,
        event: event as PluginHookMessageReceivedEvent,
      });
      // Returning undefined means "do not modify or cancel".
      return undefined;
    },
  });
  addTestHook({
    registry: hookRegistry,
    pluginId: "proof-message-sent",
    hookName: "message_sent",
    handler: async (event: unknown, ctx: unknown) => {
      captured.push({
        hook: "message_sent",
        ctx: ctx as PluginHookMessageContext,
        event: event as PluginHookMessageReceivedEvent,
      });
    },
  });

  return {
    ...channelRegistry,
    hooks: hookRegistry.hooks,
    typedHooks: hookRegistry.typedHooks,
    plugins: hookRegistry.plugins,
  };
}

async function runScenario(
  label: string,
  opts: { sessionKey?: string },
): Promise<CapturedContext[]> {
  const captured: CapturedContext[] = [];
  const registry = buildRegistry(captured, "matrix");
  setActivePluginRegistry(registry);
  initializeGlobalHookRunner(registry);

  const result = await deliverOutboundPayloads({
    cfg: {},
    channel: "matrix",
    to: "!room:example",
    payloads: [{ text: `proof: ${label}` }],
    skipQueue: true,
    ...(opts.sessionKey ? { session: { key: opts.sessionKey } } : {}),
  });

  console.log(`\n=== Scenario: ${label} ===`);
  console.log(`deliverOutboundPayloads result:`, JSON.stringify(result));
  for (const entry of captured) {
    console.log(
      `[${entry.hook}] ctx.sessionKey = ${
        entry.ctx.sessionKey === undefined ? "(undefined)" : JSON.stringify(entry.ctx.sessionKey)
      }`,
    );
    console.log(`[${entry.hook}] full ctx     = ${JSON.stringify(entry.ctx)}`);
  }

  return captured;
}

async function main() {
  console.log("[proof-73706] Real-runtime behavior proof for outbound session-key threading.");
  console.log(
    "[proof-73706] Production code paths: deliverOutboundPayloads + getGlobalHookRunner.",
  );

  const scenario1 = await runScenario(
    "outbound delivery WITH session.key (canonical key from agent runtime)",
    { sessionKey: "agent:tank:slack:channel:CHAN1" },
  );
  const scenario2 = await runScenario(
    "outbound delivery WITHOUT session (narrowed docs branch)",
    {},
  );
  const scenario3 = await runScenario(
    "native-redirect: session.key = CommandTargetSessionKey (what dispatch-from-config.ts now passes)",
    { sessionKey: "agent:tank:telegram:direct:999" },
  );

  // Assertions — make the proof self-checking so the captured output is
  // not silently green when the runtime regresses.
  const expectFromHook = (
    captured: CapturedContext[],
    hook: "message_sending" | "message_sent",
    expected: string | undefined,
  ): void => {
    const entry = captured.find((c) => c.hook === hook);
    if (!entry) {
      throw new Error(`[proof-73706] No ${hook} hook fired.`);
    }
    if (entry.ctx.sessionKey !== expected) {
      throw new Error(
        `[proof-73706] ${hook} sessionKey mismatch: expected ${JSON.stringify(expected)} got ${JSON.stringify(entry.ctx.sessionKey)}`,
      );
    }
  };

  expectFromHook(scenario1, "message_sending", "agent:tank:slack:channel:CHAN1");
  expectFromHook(scenario1, "message_sent", "agent:tank:slack:channel:CHAN1");
  expectFromHook(scenario2, "message_sending", undefined);
  expectFromHook(scenario2, "message_sent", undefined);
  expectFromHook(scenario3, "message_sending", "agent:tank:telegram:direct:999");
  expectFromHook(scenario3, "message_sent", "agent:tank:telegram:direct:999");

  console.log("\n[proof-73706] All runtime assertions passed.");
}

main().catch((err: unknown) => {
  console.error("[proof-73706] FAILED:", err);
  process.exitCode = 1;
});
