import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../runtime/index.js";
import { AgentSessionPrompting } from "./agent-session-prompting.js";

type PromptRunProbe = {
  onAgentSubmission: () => {
    settle: (outcome: "completed" | "failed") => void;
  };
  agent: {
    prompt: (messages: AgentMessage | AgentMessage[]) => Promise<void>;
    continue: () => Promise<void>;
  };
  handlePostAgentRun: () => Promise<"continue" | "settled">;
  runSubmittedAgentCall: (run: () => Promise<void>) => Promise<void>;
  systemPromptOverride?: string;
  flushPendingBashMessages: () => void;
  lastRunEndedForTurnHandoff: boolean;
  currentExtensionRunner: {
    emit: (event: { type: "agent_settled" }) => Promise<void>;
  };
};

type RunAgentPrompt = (
  this: PromptRunProbe,
  messages: AgentMessage | AgentMessage[],
) => Promise<void>;

const runAgentPrompt = Reflect.get(
  AgentSessionPrompting.prototype,
  "runAgentPrompt",
) as RunAgentPrompt;

const runSubmittedAgentCall = Reflect.get(
  AgentSessionPrompting.prototype,
  "runSubmittedAgentCall",
) as (this: PromptRunProbe, run: () => Promise<void>) => Promise<void>;

function createPromptRunProbe(params: {
  prompt?: () => Promise<void>;
  continue?: () => Promise<void>;
  actions?: Array<"continue" | "settled">;
}) {
  const order: string[] = [];
  const settlements: Array<ReturnType<typeof vi.fn>> = [];
  const actions = [...(params.actions ?? ["settled"])];
  const probe: PromptRunProbe = {
    onAgentSubmission: () => {
      order.push("submitted");
      const settle = vi.fn();
      settlements.push(settle);
      return { settle };
    },
    agent: {
      prompt: async () => {
        order.push("prompt");
        await params.prompt?.();
      },
      continue: async () => {
        order.push("continue");
        await params.continue?.();
      },
    },
    handlePostAgentRun: async () => actions.shift() ?? "settled",
    runSubmittedAgentCall,
    flushPendingBashMessages: vi.fn(),
    lastRunEndedForTurnHandoff: false,
    currentExtensionRunner: { emit: vi.fn(async () => {}) },
  };
  return { probe, order, settlements };
}

describe("agent session prompt accounting", () => {
  it("accounts for prompt and continuation agent submissions independently", async () => {
    const fixture = createPromptRunProbe({ actions: ["continue", "settled"] });

    await runAgentPrompt.call(fixture.probe, []);

    expect(fixture.order).toEqual(["submitted", "prompt", "submitted", "continue"]);
    expect(fixture.settlements).toHaveLength(2);
    expect(fixture.settlements[0]).toHaveBeenCalledWith("completed");
    expect(fixture.settlements[1]).toHaveBeenCalledWith("completed");
  });

  it("settles admitted work as failed when the prompt throws", async () => {
    const fixture = createPromptRunProbe({
      prompt: async () => {
        throw new Error("provider exploded");
      },
    });

    await expect(runAgentPrompt.call(fixture.probe, [])).rejects.toThrow("provider exploded");

    expect(fixture.order).toEqual(["submitted", "prompt"]);
    expect(fixture.settlements[0]).toHaveBeenCalledOnce();
    expect(fixture.settlements[0]).toHaveBeenCalledWith("failed");
  });

  it("settles only the failed continuation as failed", async () => {
    const fixture = createPromptRunProbe({
      actions: ["continue"],
      continue: async () => {
        throw new Error("continuation exploded");
      },
    });

    await expect(runAgentPrompt.call(fixture.probe, [])).rejects.toThrow("continuation exploded");

    expect(fixture.order).toEqual(["submitted", "prompt", "submitted", "continue"]);
    expect(fixture.settlements).toHaveLength(2);
    expect(fixture.settlements[0]).toHaveBeenCalledWith("completed");
    expect(fixture.settlements[1]).toHaveBeenCalledWith("failed");
  });

  it("does not admit work before prompt preflight succeeds", async () => {
    const onAgentSubmission = vi.fn();
    const prompt = Reflect.get(AgentSessionPrompting.prototype, "prompt") as (
      this: {
        currentExtensionRunner: { hasHandlers: () => boolean };
        expandSkillCommand: (text: string) => string;
        promptTemplates: string[];
        isStreaming: boolean;
        flushPendingBashMessages: () => void;
        model: undefined;
        onAgentSubmission: typeof onAgentSubmission;
      },
      text: string,
    ) => Promise<void>;

    await expect(
      prompt.call(
        {
          currentExtensionRunner: { hasHandlers: () => false },
          expandSkillCommand: (text) => text,
          promptTemplates: [],
          isStreaming: false,
          flushPendingBashMessages: vi.fn(),
          model: undefined,
          onAgentSubmission,
        },
        "new prompt",
      ),
    ).rejects.toThrow("No model selected");

    expect(onAgentSubmission).not.toHaveBeenCalled();
  });
});
