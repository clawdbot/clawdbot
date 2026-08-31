import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerLiveEventParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import type { AssistantMessage } from "../../llm/types.js";
import { extractFirstTextBlock } from "../../shared/chat-message-content.js";
import { createWorkerLiveRuntime } from "../../worker/embedded-agent-live.runtime.js";
import {
  ComposedGatewayHarness,
  RUN_ID,
  type WorkerClients,
} from "../../worker/worker-fault-injection.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("worker live Gateway chat projection", () => {
  let harness: ComposedGatewayHarness;
  const clients: WorkerClients[] = [];

  beforeEach(async () => {
    harness = await ComposedGatewayHarness.create(tempDirs.make("oc-wc-"));
    await harness.start();
  });

  afterEach(async () => {
    for (const current of clients.splice(0)) {
      current.inference.dispose();
      current.live.dispose();
      await current.connection.stop();
    }
    await harness.close();
  });

  async function liveProjection() {
    const current = harness.createClients();
    clients.push(current);
    await current.connection.start();
    const runtime = createWorkerLiveRuntime({
      enqueuePreview: (event) => current.live.enqueuePreview(RUN_ID, event),
      emitTerminal: (event) => current.live.emitTerminal(RUN_ID, event),
    });
    const start = () => runtime.handleSessionEvent({ type: "message_start", message: message("") });
    const preview = (message: AssistantMessage, contentIndex = 0, delta?: string) => {
      const block = message.content[contentIndex];
      runtime.handleSessionEvent({
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex,
          delta: delta ?? (block?.type === "text" ? block.text : ""),
          partial: message,
        },
      });
    };
    const end = (message: AssistantMessage) =>
      runtime.handleSessionEvent({ type: "message_end", message });
    const finish = async () => {
      runtime.handleSessionEvent({ type: "agent_end", messages: [], willRetry: false });
      await runtime.emitTerminal();
      expect(harness.chat.events.every((event) => event.state === "delta")).toBe(true);
    };
    return { runtime, start, preview, end, finish };
  }

  const message = (text: string) =>
    makeAgentAssistantMessage({ content: [{ type: "text", text }] });
  const expectChatText = async (text: string) => {
    await vi.waitFor(() => {
      const event = harness.chat.events.at(-1);
      expect(extractFirstTextBlock(event && "message" in event ? event.message : undefined)).toBe(
        text,
      );
    });
    expect(harness.chat.state.runs.get(RUN_ID)?.rawBuffer).toBe(text);
  };

  it.each([
    { prefix: "Before tool\n", final: "Revised", name: "corrected final" },
    { prefix: "Before tool\n", final: "Draft", name: "shortened final" },
    { prefix: "Before tool\n", final: "", name: "empty final after pre-tool text" },
    { prefix: "", final: "", name: "empty final clears rendered draft" },
  ])("projects a scoped worker $name", async ({ prefix, final }) => {
    const live = await liveProjection();
    if (prefix) {
      live.start();
      live.end(message(prefix));
      live.runtime.handleSessionEvent({
        type: "tool_execution_start",
        toolCallId: "read-1",
        toolName: "read",
        args: {},
      });
    }
    live.start();
    live.preview(message("Draft with stale suffix"));
    await expectChatText(prefix + "Draft with stale suffix");
    live.end(message(final));
    await live.finish();
    await expectChatText(prefix + final);
    expect(harness.chat.events.at(-1)).toMatchObject({
      state: "delta",
      deltaText: prefix + final,
      replace: true,
    });
  });

  it.each(["Same", "Same plus suffix"])(
    "keeps distinct worker messages containing %s and ignores repeated completion",
    async (second) => {
      const live = await liveProjection();
      for (const text of ["Same", second]) {
        live.start();
        live.end(message(text));
        live.end(message(text));
      }
      await live.finish();
      await expectChatText("Same" + second);
    },
  );

  it.each(["text_end", "message_end", "mixed", "explicit"] as const)(
    "reconciles worker commentary resolved at %s without removing prior answer text",
    async (phaseAt) => {
      const live = await liveProjection();
      live.start();
      live.end(message("Prior answer\n"));
      live.start();
      const commentary = {
        type: "text" as const,
        text: "Checking...",
        textSignature: JSON.stringify({ v: 1, id: "provider-block", phase: "commentary" }),
      };
      const final = {
        type: "text" as const,
        text: "Answer",
        textSignature: JSON.stringify({ v: 1, id: "answer-block", phase: "final_answer" }),
      };
      if (phaseAt !== "explicit") {
        live.preview(message(commentary.text));
        await expectChatText("Prior answer\nChecking...");
      }
      const authoritative = makeAgentAssistantMessage({
        content: phaseAt === "mixed" ? [commentary, final] : [commentary],
      });
      if (phaseAt === "text_end") {
        live.runtime.handleSessionEvent({
          type: "message_update",
          message: authoritative,
          assistantMessageEvent: {
            type: "text_end",
            contentIndex: 0,
            content: commentary.text,
            partial: authoritative,
          },
        });
        await expectChatText("Prior answer\n");
      } else if (phaseAt === "explicit") {
        live.preview(authoritative);
      }
      live.end(authoritative);
      live.end(authoritative);
      await live.finish();
      await expectChatText("Prior answer\n" + (phaseAt === "mixed" ? "Answer" : ""));
    },
  );

  it("replaces repeated bounded Unicode worker snapshots without replaying prior text", async () => {
    const live = await liveProjection();
    live.start();
    live.end(message("Before tool\n"));
    live.start();
    for (const suffix of ["", "A", "AB"]) {
      live.preview(message("🚀".repeat(9_000) + suffix), 0, suffix ? suffix.slice(-1) : undefined);
    }
    live.end(message("🚀".repeat(9_000) + "ABC"));
    const expected = "Before tool\n" + "🚀".repeat(1_023) + "…";
    await expectChatText(expected);
    const snapshots = harness.requestParams("worker.live-event").flatMap((params) => {
      const { event } = params as WorkerLiveEventParams;
      return event.kind === "assistant" ? [event.payload] : [];
    });
    expect(snapshots.slice(1).every((snapshot) => Buffer.byteLength(snapshot.text) <= 4_096)).toBe(
      true,
    );
    expect(snapshots.every((snapshot) => !snapshot.text.includes("\uFFFD"))).toBe(true);
    live.end(message("Short"));
    await expectChatText("Before tool\nShort");
    await live.finish();
  });

  it.each([undefined, "final_answer"] as const)(
    "retains earlier blocks with phase %s when a later block becomes commentary",
    async (phase) => {
      const live = await liveProjection();
      live.start();
      const earlier = {
        type: "text" as const,
        text: "Earlier block\n",
        ...(phase ? { textSignature: JSON.stringify({ v: 1, id: "earlier", phase }) } : {}),
      };
      const partial = makeAgentAssistantMessage({ content: [earlier] });
      live.preview(partial);
      await expectChatText(earlier.text);
      const pending = { type: "text" as const, text: "Checking..." };
      live.preview(makeAgentAssistantMessage({ content: [earlier, pending] }), 1);
      await expectChatText(earlier.text + pending.text);
      const authoritative = makeAgentAssistantMessage({
        content: [
          earlier,
          {
            ...pending,
            textSignature: JSON.stringify({ v: 1, id: "late-id", phase: "commentary" }),
          },
        ],
      });
      live.runtime.handleSessionEvent({
        type: "message_update",
        message: authoritative,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 1,
          content: pending.text,
          partial: authoritative,
        },
      });
      await expectChatText(earlier.text);
      live.end(authoritative);
      live.end(authoritative);
      await live.finish();
      await expectChatText(earlier.text);
    },
  );

  it("does not resurrect a capped completed prefix when the active worker snapshot shrinks", async () => {
    const live = await liveProjection();
    for (let index = 0; index < 32; index += 1) {
      live.start();
      live.end(message("x".repeat(16_000)));
    }
    await expectChatText("x".repeat(500_000));
    live.end(message("Short"));
    await expectChatText("x".repeat(484_000) + "Short");
    live.end(message(""));
    await expectChatText("x".repeat(484_000));
    await live.finish();
  });

  it("filters explicit mixed commentary from both worker snapshots and deltas", async () => {
    const live = await liveProjection();
    live.start();
    const answer = {
      type: "text" as const,
      text: "Answer",
      textSignature: JSON.stringify({ v: 1, id: "answer", phase: "final_answer" }),
    };
    live.preview(makeAgentAssistantMessage({ content: [answer] }));
    await expectChatText(answer.text);
    const mixed = makeAgentAssistantMessage({
      content: [
        answer,
        {
          type: "text",
          text: "Private commentary",
          textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
        },
      ],
    });
    live.preview(mixed, 1);
    live.end(mixed);
    await live.finish();
    await expectChatText(answer.text);
    const snapshots = harness.requestParams("worker.live-event").flatMap((params) => {
      const { event } = params as WorkerLiveEventParams;
      return event.kind === "assistant" ? [event.payload] : [];
    });
    expect(snapshots.map(({ text, delta }) => text + delta).join("")).not.toContain(
      "Private commentary",
    );
  });

  it("recovers a missed worker preview by snapshot through reordered delivery and ACK replay", async () => {
    const gate = harness.addLiveEventGate("before-service", "preview");
    const live = await liveProjection();
    harness.addFault({ kind: "drop-response", method: "worker.live-event", restart: false });
    live.start();
    live.preview(message("Seen"));
    await gate.entered.promise;
    // The next source snapshot includes text whose incremental event was missed.
    live.preview(message("Seen plus recovered suffix"), 0, " suffix");
    live.end(message("Corrected"));
    gate.release.resolve();
    await live.finish();
    await expectChatText("Corrected");
    expect(harness.connectionCount).toBeGreaterThan(1);
    expect(harness.liveDeltas.filter((delta) => delta === "Corrected")).toHaveLength(1);
  });

  it("preserves a final block that shares the commentary prefix", async () => {
    const live = await liveProjection();
    live.start();
    const commentary = {
      type: "text" as const,
      text: "Answer",
      textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
    };
    live.preview(makeAgentAssistantMessage({ content: [commentary] }));
    const final = {
      type: "text" as const,
      text: "Answer again",
      textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }),
    };
    const mixed = makeAgentAssistantMessage({ content: [commentary, final] });
    live.preview(mixed, 1);
    live.end(mixed);
    await live.finish();
    await expectChatText(final.text);
    const visibleDeltas = harness.requestParams("worker.live-event").flatMap((params) => {
      const { event } = params as WorkerLiveEventParams;
      return event.kind === "assistant" && event.payload.phase !== "commentary"
        ? [event.payload.delta]
        : [];
    });
    expect(visibleDeltas.join("")).toBe(final.text);
  });
});
