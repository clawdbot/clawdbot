// Focused incomplete-turn behavior coverage.
import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  hasCommittedMessagingToolDeliveryEvidence,
  hasOutboundDeliveryEvidence,
} from "./delivery-evidence.js";
import { buildAttemptReplayMetadata } from "./run/attempt-terminal-evidence.js";
import {
  DEFAULT_REASONING_ONLY_RETRY_LIMIT,
  resolveReasoningOnlyRetryInstruction,
} from "./run/incomplete-turn-recovery.js";
import { resolveIncompleteTurnPayloadText } from "./run/incomplete-turn-resolution.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

type LastAssistant = NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;

function makeLastAssistant(
  overrides: Omit<Partial<LastAssistant>, "stopReason"> & {
    stopReason?: LastAssistant["stopReason"] | "end_turn";
  } = {},
): LastAssistant {
  return { ...buildEmbeddedRunnerAssistant({}), ...overrides } as LastAssistant;
}

function makeIncompleteTurnParams(
  attemptOverrides: Partial<EmbeddedRunAttemptResult> = {},
  overrides: Partial<Omit<Parameters<typeof resolveIncompleteTurnPayloadText>[0], "attempt">> = {},
): Parameters<typeof resolveIncompleteTurnPayloadText>[0] {
  return {
    payloadCount: 0,
    aborted: false,
    externalAbort: false,
    timedOut: false,
    attempt: makeEmbeddedRunnerAttempt(attemptOverrides),
    ...overrides,
  };
}

function makeReasoningRetryParams(
  attemptOverrides: Partial<EmbeddedRunAttemptResult> = {},
): Parameters<typeof resolveReasoningOnlyRetryInstruction>[0] {
  return {
    provider: "openai",
    modelId: "gpt-5.4",
    aborted: false,
    timedOut: false,
    attempt: makeEmbeddedRunnerAttempt(attemptOverrides),
  };
}

describe("incomplete-turn delivery resolution", () => {
  it("suppresses the incomplete-turn warning after committed messaging text delivery", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered through the message tool."],
        lastAssistant: makeLastAssistant({
          provider: "ollama",
          model: "kimi-k2.6:cloud",
        }),
      }),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after committed messaging delivery before end_turn", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered through the message tool."],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          provider: "google",
          model: "gemini-2.5-pro",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_messaging_end_turn", type: "reasoning" }),
            },
          ],
        }),
      }),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after committed media-only messaging delivery", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        didSendViaMessagingTool: false,
        messagingToolSentMediaUrls: ["file:///tmp/render.png"],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
        }),
      }),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after committed messaging delivery even when the provider errored", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered before the provider error."],
        lastAssistant: makeLastAssistant({
          stopReason: "error",
          provider: "ollama",
          model: "kimi-k2.6:cloud",
          errorMessage: "provider failed after delivery",
        }),
      }),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after an accepted sessions_spawn terminal success", () => {
    const attemptWithAcceptedSpawn: Partial<EmbeddedRunAttemptResult> & {
      acceptedSessionSpawns: Array<{
        runId: string;
        childSessionKey: string;
        expectsCompletionMessage: boolean;
      }>;
    } = {
      assistantTexts: [],
      acceptedSessionSpawns: [
        {
          runId: "run-child",
          childSessionKey: "agent:claude:subagent:child",
          expectsCompletionMessage: true,
        },
      ],
      lastAssistant: makeLastAssistant({
        provider: "anthropic",
        model: "sonnet-4.6",
      }),
    };

    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(attemptWithAcceptedSpawn),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("surfaces one warning when only a collector was accepted", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: [],
          acceptedSessionSpawns: [
            {
              runId: "collector-run",
              childSessionKey: "agent:claude:subagent:collector",
              expectsCompletionMessage: false,
            },
          ],
          lastAssistant: makeLastAssistant({ provider: "anthropic", model: "sonnet-4.6" }),
        },
        { hadPotentialSideEffects: true },
      ),
    );

    expect(incompleteTurnText).toBe(
      "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.",
    );
  });

  it("still surfaces the incomplete-turn warning without an accepted sessions_spawn success", () => {
    const attemptWithMalformedSpawn: Partial<EmbeddedRunAttemptResult> & {
      acceptedSessionSpawns: Array<{ runId: string; childSessionKey: string }>;
    } = {
      assistantTexts: [],
      acceptedSessionSpawns: [],
      lastAssistant: makeLastAssistant({
        provider: "anthropic",
        model: "sonnet-4.6",
      }),
    };

    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(attemptWithMalformedSpawn),
    );

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("still surfaces the incomplete-turn warning when no messaging delivery was committed", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        lastAssistant: makeLastAssistant({
          stopReason: "error",
          provider: "ollama",
          model: "kimi-k2.6:cloud",
          errorMessage: "provider failed mid-turn",
        }),
      }),
    );

    expect(incompleteTurnText).toContain("verify before retrying");
  });

  it("does not treat empty committed messaging arrays as delivery", () => {
    expect(
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts: ["  "],
        messagingToolSentMediaUrls: [],
      }),
    ).toBe(false);
  });

  it("treats committed messaging media as delivery", () => {
    expect(
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: ["file:///tmp/render.png"],
      }),
    ).toBe(true);
  });

  it("treats committed messaging targets as delivery", () => {
    expect(
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [{ tool: "message", provider: "slack", to: "channel-1" }],
      }),
    ).toBe(true);
  });

  for (const { name, overrides } of [
    {
      name: "treats committed messaging text as replay-invalid side effect metadata",
      overrides: { messagingToolSentTexts: ["Delivered through the message tool."] },
    },
    {
      name: "treats async-started background tools as replay-invalid side effects",
      overrides: { toolMetas: [{ toolName: "image_generate", asyncStarted: true }] },
    },
    {
      name: "treats committed messaging media as replay-invalid side effect metadata",
      overrides: { messagingToolSentMediaUrls: ["file:///tmp/render.png"] },
    },
    {
      name: "treats committed messaging targets as replay-invalid side effect metadata",
      overrides: {
        messagingToolSentTargets: [{ tool: "message", provider: "slack", to: "channel-1" }],
      },
    },
  ]) {
    it(name, () => {
      expect(
        buildAttemptReplayMetadata({
          toolMetas: [],
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
          ...overrides,
        }),
      ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
    });
  }

  it("treats accepted sessions_spawn as replay-invalid outbound delivery", () => {
    const acceptedSessionSpawns = [
      {
        runId: "run-child",
        childSessionKey: "agent:claude:subagent:child",
      },
    ];

    expect(
      buildAttemptReplayMetadata({
        toolMetas: [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        acceptedSessionSpawns,
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
    expect(hasOutboundDeliveryEvidence({ acceptedSessionSpawns })).toBe(true);
  });

  it("ignores malformed accepted sessions_spawn delivery evidence", () => {
    expect(
      hasOutboundDeliveryEvidence({
        acceptedSessionSpawns: [
          null,
          {
            runId: "run-child",
            childSessionKey: " ",
          },
        ],
      }),
    ).toBe(false);
  });

  it("leaves committed delivery plus tool errors to the tool-error payload path", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered through the message tool."],
        lastToolError: {
          toolName: "message",
          meta: "send",
          error: "delivery failed for second target",
        },
        lastAssistant: makeLastAssistant({
          stopReason: "error",
          model: "gpt-5.4",
        }),
      }),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("does not retry reasoning-only GPT turns after side effects", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_side_effect", type: "reasoning" }),
            },
          ],
        }),
      }),
    );

    expect(retryInstruction).toBeNull();
    expect(DEFAULT_REASONING_ONLY_RETRY_LIMIT).toBe(2);
  });

  it("does not retry reasoning-only GPT turns when the assistant ended in error", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "error",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_helper_error", type: "reasoning" }),
            },
          ],
        }),
      }),
    );

    expect(retryInstruction).toBeNull();
  });

  it("does not retry reasoning-only GPT turns when visible assistant text already exists", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction(
      makeReasoningRetryParams({
        assistantTexts: ["Visible answer."],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({
                id: "rs_helper_visible_text",
                type: "reasoning",
              }),
            },
            { type: "text", text: "" },
          ],
        }),
      }),
    );

    expect(retryInstruction).toBeNull();
  });

  it("surfaces incomplete-turn text for errored signed-thinking-only turns with payloads", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            stopReason: "error",
            provider: "anthropic",
            model: "claude-opus-4-8",
            content: [
              {
                type: "thinking",
                thinking: "internal reasoning before provider error",
                thinkingSignature: JSON.stringify({ id: "rs_error_payload", type: "reasoning" }),
              },
            ],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("keeps token-limited partial answers deliverable", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Partial answer"],
          lastAssistant: makeLastAssistant({
            stopReason: "length",
            provider: "ollama",
            model: "qwen3.5",
            content: [{ type: "text", text: "Partial answer" }],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("surfaces incomplete-turn text for token-limited turns with no visible text", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: [],
          lastAssistant: makeLastAssistant({
            stopReason: "length",
            provider: "ollama",
            model: "qwen3.5",
            content: [],
          }),
        },
        { payloadCount: 0 },
      ),
    );

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("keeps complete visible stop turns successful", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Complete answer"],
          lastAssistant: makeLastAssistant({
            provider: "ollama",
            model: "qwen3.5",
            content: [{ type: "text", text: "Complete answer" }],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("preserves terminal tool media on token-limited turns", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Partial answer"],
          toolMediaUrls: ["file:///tmp/render.png"],
          lastAssistant: makeLastAssistant({
            stopReason: "length",
            provider: "ollama",
            model: "qwen3.5",
            content: [{ type: "text", text: "Partial answer" }],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("preserves tool media already delivered through block replies", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Partial answer"],
          hasToolMediaBlockReply: true,
          lastAssistant: makeLastAssistant({
            stopReason: "length",
            provider: "ollama",
            model: "qwen3.5",
            content: [{ type: "text", text: "Partial answer" }],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it("preserves successful cron progress on token-limited turns", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams(
        {
          assistantTexts: ["Partial answer"],
          successfulCronAdds: 1,
          lastAssistant: makeLastAssistant({
            stopReason: "length",
            provider: "ollama",
            model: "qwen3.5",
            content: [{ type: "text", text: "Partial answer" }],
          }),
        },
        { payloadCount: 1 },
      ),
    );

    expect(incompleteTurnText).toBeNull();
  });

  it.each([
    [
      "heartbeat responses",
      {
        heartbeatToolResponse: {
          outcome: "progress" as const,
          notify: false,
          summary: "Still working",
        },
      },
    ],
    ["tool media", { toolMediaUrls: ["file:///tmp/render.png"] }],
    ["voice media", { toolAudioAsVoice: true }],
    ["trusted local media", { toolTrustedLocalMedia: true }],
    [
      "source reply payloads",
      { messagingToolSourceReplyPayloads: [{ text: "Delivered through the source reply." }] },
    ],
    ["delivered source replies", { didDeliverSourceReplyViaMessageTool: true }],
  ] satisfies Array<[string, Partial<EmbeddedRunAttemptResult>]>)(
    "does not replace terminal %s with an incomplete-turn warning",
    (_label, attemptState) => {
      const incompleteTurnText = resolveIncompleteTurnPayloadText(
        makeIncompleteTurnParams(
          {
            assistantTexts: [],
            ...attemptState,
            lastAssistant: makeLastAssistant({
              stopReason: "error",
              provider: "anthropic",
              model: "claude-opus-4-8",
              content: [
                {
                  type: "thinking",
                  thinking: "internal reasoning before provider error",
                  thinkingSignature: JSON.stringify({
                    id: "rs_terminal_payload",
                    type: "reasoning",
                  }),
                },
              ],
            }),
          },
          { payloadCount: 1 },
        ),
      );

      expect(incompleteTurnText).toBeNull();
    },
  );
});
