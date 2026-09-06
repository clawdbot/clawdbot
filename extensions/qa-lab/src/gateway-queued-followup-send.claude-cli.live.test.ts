import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { isLiveTestEnabled, isTruthyEnvValue } from "openclaw/plugin-sdk/test-live";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { readRawQaSessionStore } from "./suite-runtime-agent-session.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const FIRST_REPLY_MARKER = "QA-CLI-QUEUED-FOLLOWUP-FIRST-OK";
const QUEUED_REPLY_MARKER = "QA-CLI-QUEUED-FOLLOWUP-SECOND-OK";
const TOOL_AUTHORITY_SNAPSHOT_ERROR = "Reply operation has no active tool authority snapshot";
const CLI_EXEC_LOG = "cli exec: provider=claude-cli";
const CLI_TURN_LOG = "cli turn: provider=claude-cli";
// The bundled Anthropic plugin's default Claude CLI model; override for a
// cheaper or faster local login.
const CLI_MODEL = process.env.OPENCLAW_LIVE_CLI_BACKEND_MODEL?.trim() || "claude-cli/claude-opus-5";

// Live: needs an installed, logged-in Claude Code executable on PATH.
//   OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CLI_BACKEND=1 pnpm test <this file>
const describeLive =
  isLiveTestEnabled() &&
  isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND) &&
  process.platform !== "win32"
    ? describe
    : describe.skip;

function countOccurrences(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

describeLive("queued follow-up after an active reply run (Claude CLI backend)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "queued follow-up CLI test cleanup failed");
    }
  });

  it("runs a message sent mid-turn through the CLI backend and delivers its reply", async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());
    const owner = createQaGatewayChild();
    cleanups.push(async () => {
      expect((await owner.stop()).errors).toEqual([]);
    });
    const gateway = await owner.start({
      repoRoot,
      providerMode: "live-frontier",
      primaryModel: CLI_MODEL,
      alternateModel: CLI_MODEL,
      // Claude Code owns its local login; forward the host home so the CLI
      // backend can reuse it (subscription mode, no API key).
      forwardHostHome: true,
      claudeCliAuthMode: "subscription",
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      runtimeEnvPatch: { OPENCLAW_LOG_LEVEL: "debug" },
      mutateConfig: (cfg) => ({
        ...cfg,
        plugins: {
          ...cfg.plugins,
          slots: { ...cfg.plugins?.slots, memory: "none" },
          entries: {
            ...cfg.plugins?.entries,
            acpx: { enabled: false },
            "memory-core": { enabled: false },
          },
        },
        // The reported loss is on the queued-followup path, so do not steer.
        messages: { ...cfg.messages, queue: { ...cfg.messages?.queue, mode: "followup" } },
      }),
    });
    const conversation = { id: "queued-followup-cli-send", kind: "direct" as const };
    const sessionKey = buildAgentSessionKey({
      agentId: "qa",
      channel: "qa-channel",
      accountId: transport.accountId,
      peer: { kind: "direct", id: `dm:${conversation.id}` },
      dmScope: gateway.cfg.session?.dmScope,
      identityLinks: gateway.cfg.session?.identityLinks,
    });
    const delivery = transport.buildAgentDelivery({ target: `dm:${conversation.id}` });
    // The qa-channel poller hands inbound messages to the Gateway one at a time
    // and waits for each reply, so a channel message can never arrive mid-run.
    // `chat.send` enters the same reply pipeline (dispatchInboundMessage ->
    // reply runner -> followup queue) without that serialization, which makes
    // the second send a genuine mid-run arrival on the shared queued path.
    const send = (text: string) =>
      gateway.call(
        "chat.send",
        {
          idempotencyKey: randomUUID(),
          sessionKey,
          message: text,
          deliver: true,
          originatingChannel: delivery.replyChannel,
          originatingTo: delivery.replyTo,
        },
        { timeoutMs: 30_000 },
      ) as Promise<{ runId?: string; status?: string }>;
    try {
      await transport.waitReady({ gateway });
      const sinceIndex = state.getSnapshot().messages.length;
      const first = await send(
        `Reply with exactly this text and nothing else: ${FIRST_REPLY_MARKER}`,
      );
      expect(first.runId).toBeTruthy();
      // Wait until the first turn has actually launched the CLI process, so
      // the second message is a genuine mid-run arrival on the CLI backend.
      await transport.waitForCondition(
        () => (gateway.logs().includes(CLI_EXEC_LOG) ? true : undefined),
        120_000,
        25,
      );
      expect(countOccurrences(gateway.logs(), CLI_TURN_LOG)).toBe(0);
      const second = await send(
        `Reply with exactly this text and nothing else: ${QUEUED_REPLY_MARKER}`,
      );
      expect(second.runId).toBeTruthy();
      // The second send was accepted while the first CLI turn was still running.
      expect(countOccurrences(gateway.logs(), CLI_TURN_LOG)).toBe(0);

      const firstReply = await transport.waitForOutbound({
        conversation,
        sinceIndex,
        textIncludes: FIRST_REPLY_MARKER,
        timeoutMs: 300_000,
      });
      // Pre-fix, the queued turn threw at route binding on CLI backends and the
      // message was dropped; the reply below never arrived.
      const queuedReply = await transport.waitForOutbound({
        conversation,
        sinceIndex,
        textIncludes: QUEUED_REPLY_MARKER,
        timeoutMs: 300_000,
      });
      expect(queuedReply.accountId).toBe(transport.accountId);

      const outbound = state
        .getSnapshot()
        .messages.slice(sinceIndex)
        .filter((message) => message.direction === "outbound");
      // Ordering: the queued turn ran and replied after the first turn finished.
      expect(outbound.findIndex((message) => message.id === firstReply.id)).toBeLessThan(
        outbound.findIndex((message) => message.id === queuedReply.id),
      );
      // Both turns completed as separate CLI executions, with no route-binding failure.
      await transport.waitForCondition(
        () => (countOccurrences(gateway.logs(), CLI_TURN_LOG) >= 2 ? true : undefined),
        30_000,
        25,
      );
      expect(gateway.logs()).not.toContain(TOOL_AUTHORITY_SNAPSHOT_ERROR);
      await transport.waitForCondition(
        async () =>
          (await readRawQaSessionStore({ gateway }))[sessionKey]?.status === "done"
            ? true
            : undefined,
        30_000,
        25,
      );
    } catch (error) {
      const sessions = await Promise.allSettled([readRawQaSessionStore({ gateway })]);
      throw new Error(
        `${String(error)}\nsessions=${JSON.stringify(sessions)}\nbus=${JSON.stringify(state.getSnapshot())}\ngateway=${gateway.logs()}`,
        { cause: error },
      );
    }
  }, 900_000);
});
