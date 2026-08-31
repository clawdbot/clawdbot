import { describe, expect, it, vi } from "vitest";
import { registerRepairableCodeModeFailure } from "../../code-mode-repair-provenance.js";
import type { Agent } from "../../runtime/index.js";
import { readToolResultDetails } from "../../tool-result-error.js";
import { installCodeModeOutcomeHook } from "./code-mode-outcome.js";

type AfterToolOutcomeContext = Parameters<NonNullable<Agent["afterToolOutcome"]>>[0];

function createOutcome(
  options: {
    bridgeStarted?: boolean;
    repairableFailure?: boolean;
    toolName?: "exec" | "wait";
    terminal?: boolean;
  } = {},
): AfterToolOutcomeContext {
  const details = {
    status: "failed",
    error: "execution failed",
    bridgeDispatchStarted: options.bridgeStarted ?? false,
  };
  if (options.repairableFailure) {
    registerRepairableCodeModeFailure(details);
  }
  const toolCall = {
    type: "toolCall" as const,
    id: "call-1",
    name: options.toolName ?? "exec",
    arguments: {},
  };
  return {
    assistantMessage: { role: "assistant", content: [toolCall], timestamp: 1 },
    toolCall,
    args: {},
    result: {
      content: [{ type: "text", text: JSON.stringify(details) }],
      details,
      ...(options.terminal ? { terminate: true } : {}),
    },
    isError: true,
    executionStarted: true,
    context: { systemPrompt: "", messages: [], tools: [] },
  } as unknown as AfterToolOutcomeContext;
}

function createAgent(previous?: Agent["afterToolOutcome"]) {
  const agent = { afterToolOutcome: previous } as Agent;
  const onReconciliationCandidate = vi.fn();
  installCodeModeOutcomeHook({ agent, onReconciliationCandidate });
  return { agent, onReconciliationCandidate };
}

describe("Code Mode outcome safety", () => {
  it("allows successive guest failures without a repair-attempt counter", async () => {
    const { agent, onReconciliationCandidate } = createAgent();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await agent.afterToolOutcome?.(createOutcome());
      expect(result).toMatchObject({ isError: true });
      expect(result).not.toHaveProperty("terminate");
    }
    expect(onReconciliationCandidate).not.toHaveBeenCalled();
  });

  it.each(["exec", "wait"] as const)(
    "accepts exact host proof once for %s, never copied or serialized proof",
    async (toolName) => {
      const outcome = createOutcome({ toolName, bridgeStarted: true, repairableFailure: true });
      const details = readToolResultDetails(outcome.result);
      for (const copied of [
        { ...details },
        structuredClone(details),
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise serialized tool results separately from in-memory clones.
        JSON.parse(JSON.stringify(details)),
      ]) {
        const { agent } = createAgent();
        await expect(
          agent.afterToolOutcome?.({
            ...outcome,
            result: { ...outcome.result, details: copied },
          }),
        ).resolves.toMatchObject({ isError: true, terminate: true });
      }

      const { agent, onReconciliationCandidate } = createAgent();
      const result = await agent.afterToolOutcome?.(outcome);
      expect(result).toMatchObject({ isError: true });
      expect.soft(result).not.toHaveProperty("terminate");
      expect(onReconciliationCandidate).not.toHaveBeenCalled();
      // The real consumer used the proof above; never mint it again for the replay.
      await expect(createAgent().agent.afterToolOutcome?.(outcome)).resolves.toMatchObject({
        isError: true,
        terminate: true,
      });
    },
  );

  it("sends uncertain bridge side effects to read-only reconciliation", async () => {
    const { agent, onReconciliationCandidate } = createAgent();

    await expect(
      agent.afterToolOutcome?.(createOutcome({ bridgeStarted: true })),
    ).resolves.toMatchObject({ isError: true, terminate: true });
    expect(onReconciliationCandidate).toHaveBeenCalledOnce();
  });

  it.each([
    { bridgeStarted: true, executionStarted: true },
    { bridgeStarted: false, executionStarted: false },
    { bridgeStarted: undefined, executionStarted: false },
  ])("keeps unproven wait failures closed: %j", async ({ bridgeStarted, executionStarted }) => {
    const { agent, onReconciliationCandidate } = createAgent();
    const outcome = createOutcome({ toolName: "wait" });
    outcome.result.details = {
      status: "failed",
      ...(bridgeStarted === undefined ? {} : { bridgeDispatchStarted: bridgeStarted }),
    };
    outcome.executionStarted = executionStarted;

    await expect(agent.afterToolOutcome?.(outcome)).resolves.toMatchObject({
      isError: true,
      terminate: true,
    });
    expect(onReconciliationCandidate).not.toHaveBeenCalled();
  });

  it.each(["exec", "wait"] as const)(
    "does not trust permission-change strings from a failed %s",
    async (toolName) => {
      const { agent } = createAgent();
      const outcome = createOutcome({ toolName, bridgeStarted: true });
      outcome.result.details = {
        status: "failed",
        code: "aborted",
        error: "Permission change",
        permissionChanged: true,
        bridgeDispatchStarted: true,
      };
      await expect(agent.afterToolOutcome?.(outcome)).resolves.toMatchObject({
        isError: true,
        terminate: true,
      });
    },
  );

  it("preserves original dispatch evidence when another hook rewrites the result", async () => {
    const { agent, onReconciliationCandidate } = createAgent(async () => ({
      content: [{ type: "text", text: "looks successful" }],
      details: { status: "completed" },
      isError: false,
      terminate: false,
    }));

    await expect(
      agent.afterToolOutcome?.(createOutcome({ bridgeStarted: true })),
    ).resolves.toMatchObject({
      details: { status: "failed", bridgeDispatchStarted: true },
      isError: true,
      terminate: true,
    });
    expect(onReconciliationCandidate).toHaveBeenCalledOnce();
  });

  it("keeps explicit terminal outcomes and hook failures closed", async () => {
    const terminalAgent = createAgent(async () => ({ terminate: false }));
    await expect(
      terminalAgent.agent.afterToolOutcome?.(
        createOutcome({
          toolName: "wait",
          terminal: true,
          bridgeStarted: true,
          repairableFailure: true,
        }),
      ),
    ).resolves.toMatchObject({ terminate: true });

    const brokenHook = createAgent(async () => {
      throw new Error("hook failed");
    });
    await expect(brokenHook.agent.afterToolOutcome?.(createOutcome())).resolves.toMatchObject({
      isError: true,
      terminate: true,
      details: { status: "failed", error: "hook failed" },
    });
  });
});
