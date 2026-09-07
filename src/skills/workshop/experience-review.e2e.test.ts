import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { text as readText } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../agents/runtime-plugins.js";
import { sanitizeToolUseResultPairingForModel } from "../../agents/session-transcript-repair.js";
import { SessionManager } from "../../agents/sessions/index.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { readSkillReviewOutcomes } from "./collection-review-state.js";
import { assertExperienceReviewDecision } from "./experience-review-decision.test-support.js";
import { readExperienceReviewMessageText } from "./experience-review-message-text.test-support.js";
import { observeExperienceReview } from "./experience-review-observation.test-support.js";
import { createSkillExperienceReviewScheduler } from "./experience-review-scheduler.js";
import { runSkillExperienceReview } from "./experience-review.js";
import {
  createExperienceReviewCandidate,
  createExperienceReviewMessages,
} from "./experience-review.test-support.js";
import {
  getSkillProposalRunProgress,
  inspectSkillProposal,
  listSkillProposals,
} from "./service.js";

const modelId = "gpt-5.6-luna";
const { positiveMessages, interruptedMessages } = createExperienceReviewMessages(modelId);
const tempDirs = createTrackedTempDirs();
let state: OpenClawTestState;
const proposalBody = [
  "# Manifest Deployment",
  "",
  "1. Read the checked-in deployment manifest and collect project, region, service, and health path.",
  "2. Deploy with the manifest values, then fetch its health path and verify a successful response.",
].join("\n");
const createArgs = {
  action: "create",
  name: "Manifest Deployment",
  description: "Deploy from a checked-in manifest and verify service health.",
  proposal_content: proposalBody,
};
type Request = {
  model?: string;
  input?: Array<{
    type?: string;
    name?: string;
    call_id?: string;
    output?: unknown;
    arguments?: string;
    content?: Array<{ text?: string }>;
  }>;
  tools?: Array<{ name?: string }>;
};
type Scenario = "proposed" | "nothing" | "interrupted" | "rejected" | "failed";

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "home", prefix: "workshop-owner-contract-" });
});
afterEach(async () => {
  await state.cleanup();
  await tempDirs.cleanup();
});

function writeToolCall(response: ServerResponse, args: Record<string, unknown>): void {
  const item = {
    type: "function_call",
    id: "fc_workshop_contract",
    call_id: "call_workshop_contract",
    name: "skill_workshop",
    arguments: JSON.stringify(args),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_workshop_contract_tool",
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ]);
}

describe("Workshop draft-only review through the real provider and tool owners", () => {
  it("reviews the completed deep turn when shallow work finishes before the idle window", async () => {
    const requests: Request[] = [];
    const handlerErrors: unknown[] = [];
    await withServer(
      (request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          requests.push(JSON.parse(await readText(request)) as Request);
          writeOpenAiResponsesText(response, {
            text: "NO_REPLY",
            messageId: "msg_workshop_delayed_review",
            responseId: "resp_workshop_delayed_review",
          });
        })().catch((error: unknown) => {
          handlerErrors.push(error);
          response.writeHead(400).end();
        });
      },
      async (baseUrl) => {
        const workspaceDir = await tempDirs.make("workshop-delayed-evidence-");
        const messages = positiveMessages();
        const replay = sanitizeToolUseResultPairingForModel(messages, true);
        const candidate = await createExperienceReviewCandidate("delayed-evidence", messages, {
          workspaceDir,
          modelId,
          baseUrl: `${baseUrl}/v1`,
          apiKey: "test-token-placeholder",
        });
        const target = await resolveAgentRunSessionTarget({
          agentId: "main",
          config: candidate.config,
          sessionId: candidate.source.sessionId,
          sessionKey: candidate.source.sessionKey,
          missingSessionKey: "resolve-existing",
        });
        loadAgentRuntimePluginRegistryHandle({ config: candidate.config, workspaceDir });
        const reviewFinished = createDeferred();
        const idleCallbacks: Array<() => void> = [];
        const scheduler = createSkillExperienceReviewScheduler({
          isSystemActive: () => false,
          setTimer: (callback, delayMs) => {
            const timer = setTimeout(callback, delayMs);
            idleCallbacks.push(() => {
              clearTimeout(timer);
              callback();
            });
            return timer;
          },
          runReview: async (pending) => {
            try {
              await runSkillExperienceReview(pending);
              reviewFinished.resolve();
            } catch (error) {
              reviewFinished.reject(error);
            }
          },
        });
        const ctx = {
          ...candidate.ctx,
          sessionKey: candidate.source.sessionKey,
          skillWorkshopAvailable: true,
          modelIterations: 10,
        };
        const laterMessages = [
          makeAgentUserMessage({ content: "What is two plus two?" }),
          makeAgentAssistantMessage({
            model: modelId,
            content: [{ type: "text", text: "Two plus two is four." }],
          }),
        ];
        try {
          const source = candidate.source;
          scheduler.schedule({
            event: { messages, success: true },
            ctx,
            config: candidate.config,
            source,
          });
          for (const message of laterMessages) {
            SessionManager.appendMessageToTranscript(target, message, {
              config: candidate.config,
            });
          }
          scheduler.schedule({
            event: { messages: laterMessages, success: true },
            ctx: { ...ctx, runId: "later-shallow-turn", modelIterations: 1 },
            config: candidate.config,
            source,
          });
          const database = openOpenClawAgentDatabase({ agentId: "main" });
          const readSourceTranscript = () =>
            database.db
              .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
              .all(target.sessionId);
          const sourceBeforeReview = readSourceTranscript();
          const releaseIdle = idleCallbacks.at(-1);
          if (!releaseIdle) {
            throw new Error("The completed deep turn did not schedule a review.");
          }
          releaseIdle();
          await reviewFinished.promise;

          expect(handlerErrors).toEqual([]);
          expect(requests).toHaveLength(1);
          const input = requests[0]!.input ?? [];
          const evidenceText = input
            .flatMap((item) => [
              ...(typeof item.output === "string" ? [item.output] : []),
              ...(item.content?.flatMap((part) => (part.text ? [part.text] : [])) ?? []),
            ])
            .join("\n");
          for (const message of laterMessages) {
            expect(evidenceText).not.toContain(readExperienceReviewMessageText(message.content));
          }
          for (const message of messages) {
            const text = readExperienceReviewMessageText(message.content);
            if (text) {
              expect(evidenceText).toContain(text);
            }
          }
          expect(
            input
              .filter((item) => item.type === "function_call")
              .map((item) => ({ name: item.name, arguments: item.arguments })),
          ).toEqual(
            replay.flatMap((message) =>
              message.role === "assistant"
                ? message.content.flatMap((part) =>
                    part.type === "toolCall"
                      ? [{ name: part.name, arguments: JSON.stringify(part.arguments) }]
                      : [],
                  )
                : [],
            ),
          );
          expect(readSourceTranscript()).toEqual(sourceBeforeReview);
        } finally {
          scheduler.clear();
        }
      },
    );
  }, 120_000);

  it.each<Scenario>(["proposed", "nothing", "interrupted", "rejected", "failed"])(
    "records %s without replacing the review runner, catalog, or proposal service",
    async (scenario) => {
      const requests: Request[] = [];
      const handlerErrors: unknown[] = [];
      await withServer(
        (request, response) => {
          void (async () => {
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end();
              return;
            }
            requests.push(JSON.parse(await readText(request)) as Request);
            if (scenario === "failed" || requests.length > 2) {
              response.writeHead(400, { "content-type": "application/json" });
              response.end(JSON.stringify({ error: { message: "Controlled provider rejection" } }));
              return;
            }
            if (requests.length === 1 && (scenario === "proposed" || scenario === "rejected")) {
              writeToolCall(response, scenario === "proposed" ? createArgs : { action: "create" });
              return;
            }
            writeOpenAiResponsesText(response, {
              text: "NO_REPLY",
              messageId: `msg_workshop_contract_${requests.length}`,
              responseId: `resp_workshop_contract_${requests.length}`,
            });
          })().catch((error: unknown) => {
            handlerErrors.push(error);
            response.writeHead(400).end();
          });
        },
        async (baseUrl) => {
          const workspaceDir = await tempDirs.make(`workshop-contract-${scenario}-`);
          const runId = `owner-contract-${scenario}`;
          const messages = scenario === "interrupted" ? interruptedMessages() : positiveMessages();
          const privateMarker = "synthetic-workshop-native-payload:";
          if (scenario === "nothing") {
            Object.assign(messages[0]!, {
              __openclaw: { upstreamUserText: privateMarker + "x".repeat(2 * 1024 * 1024) },
            });
          }
          const replay = sanitizeToolUseResultPairingForModel(messages, true);
          const candidate = await createExperienceReviewCandidate(runId, messages, {
            workspaceDir,
            modelId,
            baseUrl: `${baseUrl}/v1`,
            apiKey: "test-token-placeholder",
            turnAborted: scenario === "interrupted",
          });
          // Load the real provider plugin before entering the review lane, as the live proof does.
          loadAgentRuntimePluginRegistryHandle({ config: candidate.config, workspaceDir });
          const outcomesBefore = new Set(Object.keys(readSkillReviewOutcomes().experienceReviews));
          const database = openOpenClawAgentDatabase({ agentId: "main" });
          const foregroundFingerprint = () => {
            const hash = createHash("sha256");
            for (const row of database.db
              .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
              .iterate(candidate.source.sessionId)) {
              hash.update(String(row.event_json));
            }
            return hash.digest("hex");
          };
          const storedBefore = foregroundFingerprint();
          const startedAt = Date.now();
          const originalParse = JSON.parse;
          let privateAcquisitionBytes = 0;
          const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
            if (typeof text === "string" && text.includes(privateMarker)) {
              privateAcquisitionBytes += text.length;
            }
            return originalParse(text, reviver);
          });
          let observation: Awaited<ReturnType<typeof observeExperienceReview>> | undefined;
          const failedReview = scenario === "failed" || scenario === "rejected";
          try {
            const run = observeExperienceReview(() => runSkillExperienceReview(candidate));
            if (failedReview) {
              await expect(run).rejects.toThrow(
                scenario === "failed"
                  ? "provider rejected the request schema or tool payload"
                  : "Skill Workshop failed",
              );
            } else {
              observation = await run;
            }
          } finally {
            parseSpy.mockRestore();
          }

          expect(privateAcquisitionBytes).toBe(0);
          expect(foregroundFingerprint()).toBe(storedBefore);

          expect(handlerErrors).toEqual([]);
          expect(requests).toHaveLength(scenario === "proposed" || scenario === "rejected" ? 2 : 1);
          expect(requests[0]?.model).toBe(modelId);
          expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(["exec", "read", "skill_workshop"]),
          );
          // Request IDs are rewritten for provider replay. Compare the actual output bodies.
          expect(
            requests[0]?.input
              ?.filter((item) => item.type === "function_call_output")
              .map((item) => item.output),
          ).toEqual(
            replay
              .filter((message) => message.role === "toolResult")
              .map((message) =>
                message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
              ),
          );

          const { proposals } = await listSkillProposals({
            config: candidate.config,
            agentId: "main",
          });
          const progress = await getSkillProposalRunProgress({
            config: candidate.config,
            agentId: "main",
            runId,
          });
          const outcomes = Object.entries(readSkillReviewOutcomes().experienceReviews).filter(
            ([key]) => !outcomesBefore.has(key),
          );
          expect(outcomes).toHaveLength(1);
          const outcome = outcomes[0]![1];
          if (scenario === "proposed") {
            expect(proposals).toHaveLength(1);
            const proposal = proposals[0]!;
            expect(proposal.status).toBe("pending");
            expect(progress).toMatchObject({ mutationCount: 1, proposalIds: [proposal.id] });
            const stored = await inspectSkillProposal(proposal.id, {
              config: candidate.config,
              agentId: "main",
            });
            expect(stored?.record).toMatchObject({ autonomousCapture: true, origin: { runId } });
            expect(stored?.content).toContain(proposalBody);
            await expect(fs.stat(stored!.record.target.skillFile)).rejects.toMatchObject({
              code: "ENOENT",
            });
            expect(outcome).toMatchObject({ outcome: "proposed", proposalId: proposal.id });
            const toolOutput = requests[1]?.input?.find(
              (item) =>
                item.type === "function_call_output" && item.call_id === "call_workshop_contract",
            );
            expect(toolOutput?.output).toContain(proposal.id);
          } else {
            expect(proposals).toEqual([]);
            expect(progress.mutationCount).toBe(0);
            expect(outcome).toMatchObject({
              outcome: failedReview ? "failed" : "nothing",
            });
            if (scenario === "rejected") {
              const toolOutput = requests[1]?.input?.find(
                (item) =>
                  item.type === "function_call_output" && item.call_id === "call_workshop_contract",
              );
              expect(toolOutput?.output).toContain("required");
            }
          }
          if (!failedReview) {
            expect(outcome?.usage?.outputTokens).toBeGreaterThan(0);
            expect(observation).toBeDefined();
            const decision = assertExperienceReviewDecision({
              observation: observation!,
              messages: replay,
              progress,
              proposals,
              outcome,
              startedAt,
            });
            expect(decision).toBe(scenario === "proposed" ? "proposed" : "abstained");
          }
        },
      );
    },
    120_000,
  );
});
