// Qa Lab tests cover self check plugin behavior.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runQaScenario } from "./scenario.js";
import { createQaSelfCheckScenario } from "./self-check-scenario.js";
import type { QaSelfCheckResult } from "./self-check.js";
import { isQaSelfCheckSuccessful, resolveQaSelfCheckOutputPath } from "./self-check.js";

function makeSelfCheckResult(params: {
  scenarioStatus: "pass" | "fail";
  checkStatuses: Array<"pass" | "fail">;
}): QaSelfCheckResult {
  return {
    outputPath: "/tmp/qa-self-check.md",
    report: "",
    checks: params.checkStatuses.map((status, index) => ({
      name: `check ${String(index + 1)}`,
      status,
    })),
    scenarioResult: {
      name: "QA self-check scenario",
      status: params.scenarioStatus,
      steps: [],
    },
  };
}

describe("isQaSelfCheckSuccessful", () => {
  it("requires the scenario and every check to pass", () => {
    expect(
      isQaSelfCheckSuccessful(
        makeSelfCheckResult({ scenarioStatus: "pass", checkStatuses: ["pass"] }),
      ),
    ).toBe(true);
    expect(
      isQaSelfCheckSuccessful(
        makeSelfCheckResult({ scenarioStatus: "fail", checkStatuses: ["pass"] }),
      ),
    ).toBe(false);
    expect(
      isQaSelfCheckSuccessful(
        makeSelfCheckResult({ scenarioStatus: "pass", checkStatuses: ["pass", "fail"] }),
      ),
    ).toBe(false);
  });
});

describe("resolveQaSelfCheckOutputPath", () => {
  it("keeps explicit output paths untouched", () => {
    expect(
      resolveQaSelfCheckOutputPath({
        repoRoot: "/tmp/openclaw-repo",
        outputPath: "/tmp/custom/self-check.md",
      }),
    ).toBe("/tmp/custom/self-check.md");
  });

  it("anchors default self-check reports under unique files in the provided repo root", () => {
    const repoRoot = path.resolve("/tmp/openclaw-repo");
    const firstPath = resolveQaSelfCheckOutputPath({ repoRoot });
    const secondPath = resolveQaSelfCheckOutputPath({ repoRoot });

    expect(path.dirname(firstPath)).toBe(path.join(repoRoot, ".artifacts", "qa-e2e"));
    expect(path.basename(firstPath)).toMatch(/^self-check-[a-z0-9]+-[a-f0-9]{8}\.md$/u);
    expect(secondPath).not.toBe(firstPath);
  });
});

describe("createQaSelfCheckScenario", () => {
  function createSelfCheckHarness(delivery?: {
    directAccountId?: string;
    directTarget?: string;
    threadedTarget?: string;
  }) {
    const state = createQaBusState();
    const targets: unknown[] = [];
    const testState = {
      ...state,
      addInboundMessage: (input: Parameters<typeof state.addInboundMessage>[0]) => {
        const inbound = state.addInboundMessage(input);
        if (input.text === "hello from qa") {
          state.addOutboundMessage({
            accountId: delivery?.directAccountId,
            to: delivery?.directTarget ?? "dm:alice",
            text: "qa-echo: hello from qa",
          });
        }
        if (input.text === "inside thread") {
          state.addOutboundMessage({
            to:
              delivery?.threadedTarget ??
              `thread:${input.conversation.id}/${String(input.threadId)}`,
            text: "qa-echo: inside thread",
          });
        }
        return inbound;
      },
    };
    const performAction = async (action: string, args: Record<string, unknown>) => {
      if (action === "thread-create") {
        const thread = state.createThread({
          conversationId: String(args.channelId),
          title: String(args.title),
        });
        return {
          details: {
            target: `thread:${thread.conversationId}/${thread.id}`,
            thread,
          },
        };
      }
      const message = state.readMessage({ messageId: String(args.messageId) });
      if (args.to !== `thread:${message.conversation.id}/${String(message.threadId)}`) {
        throw new Error("qa-channel message is not in the selected conversation");
      }
      targets.push(args.to);
      if (action === "react") {
        return state.reactToMessage({
          messageId: String(args.messageId),
          emoji: String(args.emoji),
        });
      }
      if (action === "edit") {
        return state.editMessage({
          messageId: String(args.messageId),
          text: String(args.text),
        });
      }
      if (action === "delete") {
        return state.deleteMessage({ messageId: String(args.messageId) });
      }
      throw new Error(`unexpected action: ${action}`);
    };

    return {
      state,
      targets,
      run: async () =>
        await runQaScenario(createQaSelfCheckScenario({ waitTimeoutMs: 20 }), {
          state: testState,
          performAction,
        }),
    };
  }

  it("runs every roundtrip and binds lifecycle actions to the seeded message thread", async () => {
    const { state, targets, run } = createSelfCheckHarness();
    const result = await run();

    expect(result.status).toBe("pass");
    expect(result.steps.map((step) => step.name)).toEqual([
      "DM echo roundtrip",
      "Thread create and threaded echo",
      "Reaction, edit, delete lifecycle",
    ]);
    const thread = state.getSnapshot().threads[0];
    expect(thread).toBeDefined();

    expect(targets).toEqual([
      `thread:qa-room/${String(thread?.id)}`,
      `thread:qa-room/${String(thread?.id)}`,
      `thread:qa-room/${String(thread?.id)}`,
    ]);
    const deletedMessage = state.getSnapshot().messages.find((message) => message.deleted);
    if (!deletedMessage) {
      throw new Error("self-check did not preserve its deleted message tombstone");
    }
    expect(state.readMessage({ messageId: deletedMessage.id }).deleted).toBe(true);
    expect(
      state.searchMessages({ query: "inside thread" }).map((message) => message.id),
    ).not.toContain(deletedMessage.id);
  });

  it.each([
    { name: "another conversation", directTarget: "dm:mallory" },
    { name: "another account", directAccountId: "foreign", directTarget: "dm:alice" },
  ])("fails the complete self-check when Alice's reply is sent to $name", async (delivery) => {
    const { state, targets, run } = createSelfCheckHarness(delivery);
    const result = await run();

    expect(
      state
        .searchMessages({ conversationId: "alice", conversationKind: "direct" })
        .filter((message) => message.direction === "outbound"),
    ).toHaveLength(0);
    expect(result.status).toBe("fail");
    expect(result.steps).toEqual([
      expect.objectContaining({ name: "DM echo roundtrip", status: "fail" }),
    ]);
    expect(targets).toHaveLength(0);
  });

  it("fails threaded delivery at its owner before running lifecycle actions", async () => {
    const { targets, run } = createSelfCheckHarness({
      threadedTarget: "thread:qa-room/unrelated-thread",
    });
    const result = await run();

    expect(result.status).toBe("fail");
    expect(result.steps.at(-1)).toEqual(
      expect.objectContaining({ name: "Thread create and threaded echo", status: "fail" }),
    );
    expect(targets).toHaveLength(0);
  });
});
