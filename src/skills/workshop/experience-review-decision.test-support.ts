import type { AgentMessage } from "@openclaw/agent-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import type { readSkillReviewOutcomes } from "./collection-review-state.js";
import { readExperienceReviewMessageText } from "./experience-review-message-text.test-support.js";
import type { observeExperienceReview } from "./experience-review-observation.test-support.js";
import type { getSkillProposalRunProgress, listSkillProposals } from "./service.js";

export function assertExperienceReviewDecision(params: {
  observation: Awaited<ReturnType<typeof observeExperienceReview>>;
  messages: AgentMessage[];
  progress: Awaited<ReturnType<typeof getSkillProposalRunProgress>>;
  proposals: readonly Pick<
    Awaited<ReturnType<typeof listSkillProposals>>["proposals"][number],
    "id" | "status"
  >[];
  outcome: ReturnType<typeof readSkillReviewOutcomes>["experienceReviews"][string] | undefined;
  startedAt: number;
}): "proposed" | "abstained" {
  const { observation, progress, proposals, outcome } = params;
  expect(observation.requests[0]?.toolNames).toEqual(
    expect.arrayContaining(["exec", "read", "skill_workshop"]),
  );
  expect(observation.requests[0]?.outputs).toEqual(
    params.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => readExperienceReviewMessageText(message.content)),
  );
  expect(outcome?.attemptedAtMs).toBeGreaterThanOrEqual(params.startedAt);
  expect(outcome?.usage?.outputTokens).toBeGreaterThan(0);
  expect(observation.toolResults.some((result) => result.isError)).toBe(false);
  for (const call of observation.toolCalls) {
    expect(call.name).toBe("skill_workshop");
    expect(observation.toolResults).toContainEqual(
      expect.objectContaining({ toolName: call.name, toolCallId: call.id, isError: false }),
    );
  }
  const mutations = observation.toolCalls.filter(
    (call) =>
      call.name === "skill_workshop" &&
      isRecord(call.arguments) &&
      ["create", "patch", "update", "revise"].includes(String(call.arguments.action)),
  );
  if (progress.mutationCount === 0) {
    expect(mutations).toHaveLength(0);
    for (const call of observation.toolCalls) {
      expect(isRecord(call.arguments) && call.arguments.action).toSatisfy(
        (action: unknown) =>
          action === "list" ||
          action === "inspect" ||
          action === "read" ||
          action === "prepare_patch",
      );
    }
    expect(progress.proposalIds).toEqual([]);
    expect(observation.finalText).toBe("NO_REPLY");
    expect(outcome?.outcome).toBe("nothing");
    return "abstained";
  }
  expect(progress.mutationCount).toBe(1);
  expect(progress.proposalIds).toHaveLength(1);
  expect(mutations).toHaveLength(1);
  const proposalId = progress.proposalIds[0]!;
  expect(proposals).toContainEqual(expect.objectContaining({ id: proposalId, status: "pending" }));
  const receipt = observation.toolResults.find(
    (result) => result.toolName === "skill_workshop" && result.toolCallId === mutations[0]!.id,
  );
  expect(receipt && readExperienceReviewMessageText(receipt.content)).toContain(proposalId);
  expect(outcome).toMatchObject({ outcome: "proposed", proposalId });
  return "proposed";
}
