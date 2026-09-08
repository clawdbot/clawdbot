import { describe, expect, it } from "vitest";
import type { AttemptParamsLike } from "./attempt-types.js";
import { buildCopilotPromptGuidance } from "./prompt-guidance.js";

const fullDelegationTools = [
  "message",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "skill_workshop",
  "subagents",
];

function buildGuidance(
  attempt: Partial<AttemptParamsLike> = {},
  callableToolNames: Iterable<string> = fullDelegationTools,
): string | undefined {
  return buildCopilotPromptGuidance({
    attempt: {
      agentId: "main",
      config: {},
      sessionKey: "agent:main:main",
      sourceReplyDeliveryMode: "automatic",
      ...attempt,
    } as AttemptParamsLike,
    callableToolNames,
  });
}

describe("buildCopilotPromptGuidance", () => {
  it("composes ordered OpenClaw policy from the final callable capabilities", () => {
    const guidance = buildGuidance();

    expect(guidance).toContain("policy-filtered for this turn");
    expect(guidance).toContain("## Skill Workshop");
    expect(guidance).toContain("## Delegation");
    expect(guidance).toContain("delegate via `sessions_spawn`");
    expect(guidance).toContain("spawn `sessions_spawn` with `visible=true`");
    expect(guidance).toContain("Need announced results before reply: `sessions_yield`");
    expect(guidance).toContain("Collectors require explicit result collection instead.");
    expect(guidance).toContain("`subagents(action=list)` only for requested status/debug.");
    expect(guidance).toContain("You can participate in the conversation throughout your work.");
    expect(guidance?.indexOf("## Skill Workshop")).toBeLessThan(
      guidance?.indexOf("## Delegation") ?? 0,
    );
    expect(guidance?.indexOf("## Delegation")).toBeLessThan(
      guidance?.indexOf("You can participate in the conversation throughout your work.") ?? 0,
    );
  });

  it.each([
    {
      name: "explicit suggest mode",
      attempt: {
        config: { agents: { defaults: { subagents: { delegationMode: "suggest" as const } } } },
      },
    },
    {
      name: "non-main session",
      attempt: { sessionKey: "agent:main:slack:channel:C01234567" },
    },
    { name: "minimal prompt", attempt: { promptMode: "minimal" as const } },
    { name: "report-only delegation", attempt: { delegationCapability: "report_only" as const } },
  ])("suppresses delegation for $name but keeps visible-reply guidance", ({ attempt }) => {
    const guidance = buildGuidance(attempt);

    expect(guidance).not.toContain("## Delegation");
    expect(guidance).toContain("You can participate in the conversation throughout your work.");
  });

  it.each([
    { name: "prompt mode none", attempt: { promptMode: "none" as const } },
    { name: "raw model run", attempt: { modelRun: true } },
  ])("omits the appended developer instructions for $name", ({ attempt }) => {
    expect(buildGuidance(attempt)).toBeUndefined();
  });

  it("uses the message tool only when it remains callable", () => {
    expect(
      buildGuidance({ sourceReplyDeliveryMode: "message_tool_only" }, [
        "message",
        "sessions_spawn",
      ]),
    ).toContain("Visible source replies are not automatically delivered");
    const unavailable = buildGuidance({ sourceReplyDeliveryMode: "message_tool_only" }, [
      "sessions_spawn",
    ]);
    expect(unavailable).toContain("remains private");
    expect(unavailable).not.toContain("Use `message`");
    expect(unavailable).not.toContain("OpenClaw delivers your final response automatically");
  });

  it.each([false, true])(
    "teaches the prepared target requirement (%s) only with message",
    (required) => {
      const attempt = {
        agentId: "main",
        config: {},
        sessionKey: "agent:main:main",
        sourceReplyDeliveryMode: "message_tool_only" as const,
      } as AttemptParamsLike;
      const guidance = buildCopilotPromptGuidance({
        attempt,
        callableToolNames: ["message"],
        requireExplicitMessageTarget: required,
      });
      expect(guidance).toContain(
        required ? "target required this turn" : "current source is default target",
      );
      const unavailable = buildCopilotPromptGuidance({
        attempt,
        callableToolNames: [],
        requireExplicitMessageTarget: required,
      });
      expect(unavailable).toContain("remains private");
      expect(unavailable).not.toContain("`target`");
    },
  );

  it("renders only the delegation operations present in the callable inventory", () => {
    const guidance = buildGuidance({}, [" sessions_spawn ", "sessions_spawn"]);

    expect(guidance).toContain("## Delegation");
    expect(guidance).toContain(
      "Announced completion is push-based; collectors require explicit result collection.",
    );
    expect(guidance).not.toContain("sessions_yield");
    expect(guidance).not.toContain("subagents(action=list)");
    expect(buildGuidance({}, ["sessions_yield", "subagents"])).not.toContain("## Delegation");
  });

  it.each([
    { name: "callable", tools: ["secrets"], disabled: false, discoverable: true },
    { name: "absent", tools: [], disabled: false, discoverable: false },
    { name: "disabled", tools: ["secrets"], disabled: true, discoverable: false },
  ])("gates credential guidance on the $name tool surface", ({ tools, disabled, discoverable }) => {
    const guidance = buildGuidance({ disableTools: disabled }, tools);
    expect(guidance?.includes("`secrets`: list metadata first")).toBe(discoverable);
    expect(guidance).toContain("host-owned masked credential entry");
  });

  it("wraps conversation and subagent context without adding workspace prompt sections", () => {
    expect(buildGuidance({ extraSystemPrompt: "Conversation policy." })).toContain(
      "## Conversation Context\nConversation policy.",
    );
    const minimal = buildGuidance({ extraSystemPrompt: "Child policy.", promptMode: "minimal" });
    expect(minimal).toContain("## Subagent Context\nChild policy.");
    expect(minimal).not.toContain("## Workspace");
  });
});
