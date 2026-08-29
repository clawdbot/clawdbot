import path from "node:path";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { isQaPosixProcessGroupAlive, signalQaPosixProcessGroup } from "./posix-process-group.js";
import { QA_REPEATED_REQUEST_QUEUED_REPLY_MARKER } from "./providers/mock-openai/mock-openai-contracts.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { waitForQaTransportCondition } from "./qa-transport.js";
import {
  readRawQaSessionStore,
  readSessionTranscriptSummary,
} from "./suite-runtime-agent-session.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

describe.skipIf(process.platform === "win32")("gateway hard-kill recovery", () => {
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
      throw new AggregateError(errors, "hard-kill recovery test cleanup failed");
    }
  });

  it("reconciles an orphaned run and replies to a new inbound send after SIGKILL", async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());
    const mock = await startQaMockOpenAiServer();
    cleanups.push(() => mock.stop());
    const owner = createQaGatewayChild();
    cleanups.push(async () => {
      expect((await owner.stop()).errors).toEqual([]);
    });
    const gateway = await owner.start({
      repoRoot,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      forcedRuntime: "openclaw",
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
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
        tools: {
          ...cfg.tools,
          alsoAllow: ["qa_restart_wait", "qa_restart_unsafe_probe"],
          // Suspend the 30-second tool so the model's wait is pending at SIGKILL.
          codeMode: { enabled: true, timeoutMs: 10_000 },
        },
      }),
    });
    const conversation = { id: "kill-restart-send", kind: "direct" as const };
    const sessionKey = buildAgentSessionKey({
      agentId: "qa",
      channel: "qa-channel",
      accountId: transport.accountId,
      peer: { kind: "direct", id: `dm:${conversation.id}` },
      dmScope: gateway.cfg.session?.dmScope,
      identityLinks: gateway.cfg.session?.identityLinks,
    });
    try {
      await transport.waitReady({ gateway });
      await transport.sendInbound({
        accountId: transport.accountId,
        conversation,
        senderId: conversation.id,
        text: "Code Mode restart wait QA check. Original prompt marker: KILL-RESTART-PROMPT.",
      });
      const pending = await transport.waitForCondition(
        async () => {
          const entry = (await readRawQaSessionStore({ gateway }))[sessionKey];
          if (entry?.status !== "running") {
            return undefined;
          }
          const transcript = await readSessionTranscriptSummary({ gateway }, sessionKey);
          return (transcript.assistantToolCallCounts.wait ?? 0) >
            (transcript.completedToolCallCounts.wait ?? 0)
            ? { entry, transcript }
            : undefined;
        },
        120_000,
        25,
      );
      const pid = gateway.pid;
      expect(pid).not.toBeNull();
      // Kill the owned process group so no gateway or descendant can drain.
      expect(signalQaPosixProcessGroup(pid!, "SIGKILL")).toBeUndefined();
      await waitForQaTransportCondition(
        () => (!isQaPosixProcessGroupAlive(pid!) ? true : undefined),
        30_000,
        25,
      );
      await gateway.restartAfterStateMutation(async () => {
        const orphan = (await readRawQaSessionStore({ gateway }))[sessionKey];
        expect(orphan).toMatchObject({ sessionId: pending.entry.sessionId, status: "running" });
        expect(orphan?.abortedLastRun).not.toBe(true);
      });
      expect(gateway.pid).not.toBe(pid);
      await transport.waitReady({ gateway });
      await transport.waitForCondition(
        async () => {
          if (!gateway.logs().includes("dispatching restart-safe recovery")) {
            return undefined;
          }
          const transcript = await readSessionTranscriptSummary({ gateway }, sessionKey);
          return transcript.eventCursor > pending.transcript.eventCursor ? true : undefined;
        },
        120_000,
        25,
      );
      expect(gateway.logs()).toContain("marked 1 startup-orphaned main session(s)");

      const sinceIndex = state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound").length;
      const second = await transport.sendInbound({
        accountId: transport.accountId,
        conversation,
        senderId: conversation.id,
        // This current-turn fixture takes precedence over the restart prompt in history.
        text: "repeated request queued reply gateway qa check",
      });
      const reply = await transport.waitForOutbound({
        conversation,
        sinceIndex,
        textIncludes: QA_REPEATED_REQUEST_QUEUED_REPLY_MARKER,
        timeoutMs: 180_000,
      });
      expect(reply.replyToId).toBe(second.id);
      expect(reply.accountId).toBe(transport.accountId);
      const settled = await transport.waitForCondition(
        async () => {
          const entry = (await readRawQaSessionStore({ gateway }))[sessionKey];
          return entry?.status === "done" ? entry : undefined;
        },
        30_000,
        25,
      );
      expect(settled.sessionId).toBe(pending.entry.sessionId);
    } catch (error) {
      const diagnostics = await Promise.allSettled([
        readRawQaSessionStore({ gateway }),
        readSessionTranscriptSummary({ gateway }, sessionKey, { allowEmpty: true }),
      ]);
      throw new Error(
        `${String(error)}\nsessions=${JSON.stringify(diagnostics)}\nbus=${JSON.stringify(state.getSnapshot())}\ngateway=${gateway.logs()}`,
        { cause: error },
      );
    }
    // Nominal runtime is ~130s; heavily loaded hosts stretch child boots and
    // waits severalfold, so the budget leaves real headroom before flaking.
  }, 600_000);
});
