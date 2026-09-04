/**
 * Tests agent harness runtime helpers and task dispatch behavior.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import {
  agentHarnessStructuredInput,
  attachModelProviderRequestTransport,
  buildAgentHarnessUserInputAnswers,
  classifyAgentHarnessTerminalOutcome,
  deliverAgentHarnessUserInputPrompt,
  formatAgentHarnessUserInputPrompt,
  getModelProviderRequestTransport,
  queueAgentHarnessMessage,
  setActiveEmbeddedRun,
  type AgentHarness,
  type AgentHarnessQuestionGatewayCall,
  type AgentHarnessAttemptParams,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessSideQuestionParams,
  type AgentHarnessSideQuestionParamsV2,
  type AgentHarnessSupportContext,
  type AgentHarnessTerminalOutcomeClassification,
  type AgentHarnessV2,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptParamsV2,
} from "./agent-harness-runtime.js";
import type {
  ProviderModelRouteRuntimePolicy,
  ProviderRouteOverridePresence,
} from "./provider-model-types.js";

describe("classifyAgentHarnessTerminalOutcome", () => {
  it("does not classify an in-flight turn", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: [],
        reasoningText: "",
        planText: "",
        promptError: null,
        turnCompleted: false,
      }),
    ).toBeUndefined();
  });

  it("does not classify prompt errors as terminal empty-output outcomes", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: [],
        reasoningText: "",
        planText: "",
        promptError: new Error("turn failed"),
        turnCompleted: true,
      }),
    ).toBeUndefined();
  });

  it("does not classify deliberate silent replies such as NO_REPLY", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: ["NO_REPLY"],
        reasoningText: "",
        planText: "",
        promptError: null,
        turnCompleted: true,
      }),
    ).toBeUndefined();
  });

  it("treats empty-string prompt errors as terminal errors", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: [],
        reasoningText: "",
        planText: "",
        promptError: "",
        turnCompleted: true,
      }),
    ).toBeUndefined();
  });

  it("treats whitespace-only assistant text as not visible", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: ["  ", "\n\t"],
        reasoningText: "",
        planText: "",
        promptError: null,
        turnCompleted: true,
      }),
    ).toBe("empty");
  });

  it("classifies a completed turn with plan text only as planning-only", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: [],
        reasoningText: "",
        planText: "1. inspect\n2. patch\n3. test",
        promptError: null,
        turnCompleted: true,
      }),
    ).toBe("planning-only");
  });

  it("prefers planning-only when both plan and reasoning text are present", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: [],
        reasoningText: "I need to inspect the files.",
        planText: "I will inspect, patch, and test.",
        promptError: null,
        turnCompleted: true,
      }),
    ).toBe("planning-only");
  });

  it("classifies a completed turn with reasoning text only as reasoning-only", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: [],
        reasoningText: "The answer depends on the current repository state.",
        planText: "",
        promptError: null,
        turnCompleted: true,
      }),
    ).toBe("reasoning-only");
  });

  it("classifies a completed turn with no visible output as empty", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: [],
        reasoningText: "  ",
        planText: "\n",
        promptError: null,
        turnCompleted: true,
      }),
    ).toBe("empty");
  });

  it("returns only terminal fallback classifications, not ok", () => {
    const classification: AgentHarnessTerminalOutcomeClassification =
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: [],
        reasoningText: "",
        planText: "",
        promptError: null,
        turnCompleted: true,
      }) ?? "empty";

    expect(classification).toBe("empty");
  });
});

describe("agent harness runtime SDK facade", () => {
  it("exposes structured input through one frozen named runtime surface", () => {
    expect(Object.isFrozen(agentHarnessStructuredInput)).toBe(true);
    expect(Object.keys(agentHarnessStructuredInput).toSorted()).toEqual([
      "compileForm",
      "compileQuestions",
      "compileUrl",
      "isRecord",
      "run",
      "snapshot",
    ]);
  });

  it("keeps legacy harness implementations source-compatible while requiring capabilities in V2", () => {
    const legacyHarness = {
      id: "legacy-test",
      label: "Legacy test harness",
      supports: () => ({ supported: true as const, priority: 1 }),
      runAttempt: async (_params: AgentHarnessAttemptParams) => {
        throw new Error("type-only legacy harness");
      },
      runSideQuestion: async (_params: AgentHarnessSideQuestionParams) => ({ text: "legacy" }),
    } satisfies AgentHarness;

    expectTypeOf(legacyHarness).toMatchTypeOf<AgentHarness>();
    expectTypeOf<AgentHarnessV2>().toMatchTypeOf<AgentHarness>();
    expectTypeOf<
      Omit<AgentHarnessSideQuestionParams, "hostCapabilities">
    >().toMatchTypeOf<AgentHarnessSideQuestionParams>();
    expectTypeOf<
      Omit<AgentHarnessAttemptParams, "hostCapabilities">
    >().toMatchTypeOf<AgentHarnessAttemptParams>();
    expectTypeOf<
      Omit<EmbeddedRunAttemptParams, "hostCapabilities">
    >().toMatchTypeOf<EmbeddedRunAttemptParams>();
    expectTypeOf<
      Omit<AgentHarnessAttemptParamsV2, "hostCapabilities"> extends AgentHarnessAttemptParamsV2
        ? true
        : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Omit<EmbeddedRunAttemptParamsV2, "hostCapabilities"> extends EmbeddedRunAttemptParamsV2
        ? true
        : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Omit<
        AgentHarnessSideQuestionParamsV2,
        "hostCapabilities"
      > extends AgentHarnessSideQuestionParamsV2
        ? true
        : false
    >().toEqualTypeOf<false>();

    // v2026.8.1 queue/register callers need neither a source predicate nor V2.
    type QueueOptions = Parameters<typeof queueAgentHarnessMessage>[2];
    const legacyInjection = {
      isAvailable: () => true,
      queueMessage: async (_text: string, _options?: QueueOptions) => {},
    };
    const legacyHandle = {
      queueMessage: legacyInjection.queueMessage,
      messageInjection: legacyInjection,
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    } satisfies Parameters<typeof setActiveEmbeddedRun>[1];
    expectTypeOf(legacyHandle).toMatchTypeOf<Parameters<typeof setActiveEmbeddedRun>[1]>();
    expectTypeOf(queueAgentHarnessMessage).returns.toEqualTypeOf<boolean>();
    type GuardedInjection = NonNullable<
      Parameters<typeof setActiveEmbeddedRun>[1]["messageInjectionV2"]
    >;
    expectTypeOf<Parameters<GuardedInjection["queueMessage"]>[2]>().toEqualTypeOf<() => void>();
    expectTypeOf<Parameters<GuardedInjection["queueMessage"]>[3]>().toEqualTypeOf<
      "run" | "source-bound"
    >();
    expectTypeOf<Parameters<GuardedInjection["queueMessage"]>["length"]>().toEqualTypeOf<4>();
  });

  it("keeps legacy question callbacks and requires explicit guarded dispatch authority", () => {
    type Legacy = (
      method: string,
      opts: { timeoutMs?: number },
      params?: unknown,
      extra?: { signal?: AbortSignal },
    ) => Promise<unknown>;
    expectTypeOf<AgentHarnessQuestionGatewayCall>().toEqualTypeOf<Legacy>();
    type Override = Parameters<typeof agentHarnessStructuredInput.run>[0]["gatewayCall"];
    expectTypeOf<Legacy>().toMatchTypeOf<Override>();
    expectTypeOf<undefined>().toMatchTypeOf<Override>();
    type Dispatcher = Exclude<Override, Legacy | undefined>;
    type Request = Parameters<Dispatcher["call"]>[0];
    type Protected = Extract<Request["authority"], { kind: "source-bound" }>;
    expectTypeOf<Dispatcher["version"]>().toEqualTypeOf<2>();
    expectTypeOf<Protected["assertCurrent"]>().toEqualTypeOf<() => void>();
    expectTypeOf<Omit<Protected, "assertCurrent">>().not.toMatchTypeOf<Protected>();
  });

  it("exposes attached model request transport metadata helpers", () => {
    const model = attachModelProviderRequestTransport(
      { id: "gpt-test", provider: "custom-openai" },
      { auth: { mode: "header", headerName: "x-api-key", value: "secret" } },
    );

    expect(getModelProviderRequestTransport(model)).toEqual({
      auth: { mode: "header", headerName: "x-api-key", value: "secret" },
    });
  });

  it("locks the request-transport support contract", () => {
    expectTypeOf<
      NonNullable<AgentHarnessSupportContext["modelProvider"]>["requestTransportOverrides"]
    >().toEqualTypeOf<ProviderRouteOverridePresence | undefined>();
    expectTypeOf<
      NonNullable<AgentHarnessSupportContext["modelProvider"]>["runtimePolicy"]
    >().toEqualTypeOf<ProviderModelRouteRuntimePolicy | undefined>();
  });

  it("exports the V2 isolated-completion authorization contract through the harness", () => {
    type IsolatedCompletionV2 = NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>;

    expectTypeOf<Parameters<IsolatedCompletionV2>[0]["authorization"]["owner"]>().toEqualTypeOf<
      "host" | "harness"
    >();
    expectTypeOf<Awaited<ReturnType<IsolatedCompletionV2>>["assistant"]>().not.toBeNever();
  });
});

describe("agent harness user input helpers", () => {
  it("authorizes host-owned text-only harness updates without altering their visible payload", async () => {
    const onBlockReply = vi.fn();

    await deliverAgentHarnessUserInputPrompt({ onBlockReply }, [], {
      intro: "Which environment should I use?",
    });

    const payload = onBlockReply.mock.calls[0]?.[0];
    expect(payload).toEqual({ text: "Which environment should I use?", presentation: undefined });
    expect(getReplyPayloadMetadata(payload)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it("formats prompts and delivers through blocking replies first", async () => {
    const onBlockReply = vi.fn();

    await deliverAgentHarnessUserInputPrompt(
      { onBlockReply },
      [
        {
          id: "mode",
          header: "Mode",
          question: "Pick a mode",
          isOther: true,
          options: [{ label: "Deep", description: "Use more context" }],
        },
      ],
      { intro: "Runtime needs input:" },
    );

    expect(onBlockReply).toHaveBeenCalledWith({
      text: [
        "Runtime needs input:",
        "",
        "Mode",
        "Pick a mode",
        "1. Deep - Use more context",
        "Other: reply with your own answer.",
      ].join("\n"),
    });
  });

  it("normalizes keyed multi-question answers with option indexes", () => {
    expect(
      buildAgentHarnessUserInputAnswers(
        [
          {
            id: "repo",
            header: "Repository",
            question: "Which repo?",
            isOther: true,
          },
          {
            id: "mode",
            header: "Mode",
            question: "Which mode?",
            isOther: false,
            options: [{ label: "Fast" }, { label: "Deep" }],
          },
        ],
        "repo: openclaw\nmode: 2",
      ),
    ).toEqual({
      answers: {
        mode: { answers: ["Deep"] },
        repo: { answers: ["openclaw"] },
      },
    });
  });

  it("normalizes every selected option in a multi-select answer", () => {
    expect(
      buildAgentHarnessUserInputAnswers(
        [
          {
            id: "checks",
            header: "Checks",
            question: "Which checks should run?",
            multiSelect: true,
            isOther: true,
            options: [{ label: "Unit" }, { label: "Lint" }, { label: "Deploy preview" }],
          },
        ],
        "1, Deploy preview",
      ),
    ).toEqual({ answers: { checks: { answers: ["Unit", "Deploy preview"] } } });
  });

  it("keeps a comma-containing option label as one multi-select answer", () => {
    expect(
      buildAgentHarnessUserInputAnswers(
        [
          {
            id: "region",
            header: "Region",
            question: "Which region should deploy?",
            multiSelect: true,
            isOther: true,
            options: [{ label: "Frankfurt, Germany" }, { label: "Dublin, Ireland" }],
          },
        ],
        "Frankfurt, Germany",
      ),
    ).toEqual({ answers: { region: { answers: ["Frankfurt, Germany"] } } });
  });

  it("supports runtime-specific text formatting", () => {
    expect(
      formatAgentHarnessUserInputPrompt(
        [
          {
            id: "answer",
            header: "Header",
            question: "a < b",
          },
        ],
        { formatText: (text) => text.replaceAll("<", "&lt;") },
      ),
    ).toContain("a &lt; b");
  });

  it("preserves blank fallback lines so skipped answers stay aligned", () => {
    expect(
      buildAgentHarnessUserInputAnswers(
        [
          { id: "q1", header: "Q1", question: "First?" },
          { id: "q2", header: "Q2", question: "Second?" },
          { id: "q3", header: "Q3", question: "Third?" },
        ],
        "\nyes\nno",
      ),
    ).toEqual({
      answers: {
        q1: { answers: [] },
        q2: { answers: ["yes"] },
        q3: { answers: ["no"] },
      },
    });
  });
});
