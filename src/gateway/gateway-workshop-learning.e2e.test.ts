import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry, loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { readSkillReviewOutcomes } from "../skills/workshop/collection-review-state.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type ProviderRequest = {
  input?: Array<{
    type?: string;
    role?: string;
    call_id?: string;
    output?: unknown;
    content?: Array<{ text?: string }>;
  }>;
  tools?: Array<{ name?: string }>;
};

function respondWithTool(
  response: ServerResponse,
  callId: string,
  name: string,
  args: Record<string, unknown>,
): void {
  const item = {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name,
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
        id: `resp_${callId}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ]);
}

describe("Gateway automatic Workshop learning", () => {
  it(
    "maintains a complete skill package within Workshop while foreground work continues",
    { timeout: 150_000 },
    async () => {
      const state = await createOpenClawTestState({
        layout: "home",
        prefix: "openclaw-gateway-workshop-learning-",
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      });
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      const providerErrors: unknown[] = [];
      const providerRequests: ProviderRequest[] = [];
      const reviewRequests: ProviderRequest[] = [];
      const laterForegroundRequests: ProviderRequest[] = [];
      const reviewStarted = createDeferred();
      const releaseReview = createDeferred();
      let reviewActions: Array<{ name: string; args: Record<string, unknown> }> = [];
      let foregroundRequests = 0;
      const laterMessage = "FOREGROUND_OVERLAP_CHECK: reply with FOREGROUND_OVERLAP_COMPLETE.";
      const laterReply = "FOREGROUND_OVERLAP_COMPLETE";
      const outsideFile = path.join(state.workspaceDir, "operator-owned.txt");
      const outsideContent = "OUTSIDE_WORKSHOP_SENTINEL_MUST_NOT_ENTER_REVIEW\n";
      const oldRule = "Declare publication complete when the health check is green.";
      const newRule =
        "Declare publication complete only when the public generation matches the release.";
      const originalSkill = [
        "---",
        "name: map-publication",
        "description: Publish map generations and verify public routing.",
        "---",
        "# Map publication",
        "",
        "Read references/activation.md before publishing.",
        oldRule,
        "",
        ...Array.from(
          { length: 180 },
          (_, index) =>
            `Tile family ${index}: preserve its independent regional routing requirement during release verification.`,
        ),
        "",
        "Retain the distinct rollback procedure after verifying the previous public generation.",
      ].join("\n");
      const originalSupport = `# Activation\n\n${oldRule}\nKeep the activation receipt until verification completes.\n`;
      try {
        await fs.mkdir(state.workspaceDir, { recursive: true });
        await fs.writeFile(outsideFile, outsideContent);
        await Promise.all(
          Array.from({ length: 9 }, (_, index) =>
            fs.writeFile(
              path.join(state.workspaceDir, `receipt-${index + 1}.txt`),
              `Release step ${index + 1}: ${index === 8 ? "public generation matches the submitted release" : "accepted"}.\n`,
            ),
          ),
        );
        await withServer(
          (request, response) => {
            void (async () => {
              if (request.method !== "POST" || request.url !== "/v1/responses") {
                response.writeHead(404).end();
                return;
              }
              const payload = JSON.parse(await readText(request)) as ProviderRequest;
              providerRequests.push(payload);
              // Runtime context can append a user-role item after the actual request.
              if (
                payload.input?.some(
                  (item) =>
                    item.role === "user" &&
                    item.content?.some((part) => part.text?.includes(laterMessage)),
                )
              ) {
                laterForegroundRequests.push(payload);
                writeOpenAiResponsesText(response, {
                  text: laterReply,
                  messageId: "later_foreground_done",
                  responseId: "later_foreground_done",
                });
                return;
              }
              if (foregroundRequests < 10) {
                foregroundRequests += 1;
                if (foregroundRequests < 10) {
                  respondWithTool(response, `foreground_${foregroundRequests}`, "read", {
                    path: `receipt-${foregroundRequests}.txt`,
                  });
                } else {
                  writeOpenAiResponsesText(response, {
                    text: "Verified all receipts. Public generation matches the release; health alone was insufficient.",
                    messageId: "foreground_done",
                    responseId: "foreground_done",
                  });
                }
                return;
              }
              reviewRequests.push(payload);
              if (reviewRequests.length === 1) {
                reviewStarted.resolve();
                await releaseReview.promise;
              }
              const next = reviewActions[reviewRequests.length - 1];
              if (next) {
                respondWithTool(response, `review_${reviewRequests.length}`, next.name, next.args);
              } else {
                writeOpenAiResponsesText(response, {
                  text: "Reviewed the publication skill and activation reference. File tool results record whether the correction completed.",
                  messageId: "review_done",
                  responseId: "review_done",
                });
              }
            })().catch((error: unknown) => {
              providerErrors.push(error);
              response.writeHead(500).end(String(error));
            });
          },
          async (baseUrl) => {
            const provider = buildMockOpenAiResponsesProvider(`${baseUrl}/v1`, "workshop-learning");
            const token = "isolated-workshop-learning-token";
            const config = {
              agents: {
                defaults: {
                  workspace: state.workspaceDir,
                  skipBootstrap: true,
                  model: { primary: provider.modelRef },
                  models: {
                    [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                  },
                },
              },
              gateway: { auth: { mode: "token", token } },
              models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
              plugins: { slots: { memory: "none" } },
              tools: { profile: "coding" },
              skills: { workshop: { autonomous: { mode: "auto" } } },
            } satisfies OpenClawConfig;
            const workshop = resolveWorkshopSkillsDir(config, "main");
            const skillFile = path.join(workshop, "map-publication", "SKILL.md");
            const supportFile = path.join(
              workshop,
              "map-publication",
              "references",
              "activation.md",
            );
            await fs.mkdir(path.dirname(supportFile), { recursive: true });
            await fs.writeFile(skillFile, originalSkill);
            await fs.writeFile(supportFile, originalSupport);
            reviewActions = [
              { name: "read", args: { path: outsideFile } },
              { name: "read", args: { path: skillFile } },
              { name: "read", args: { path: supportFile } },
              {
                name: "edit",
                args: { path: skillFile, edits: [{ oldText: oldRule, newText: newRule }] },
              },
              {
                name: "edit",
                args: { path: supportFile, edits: [{ oldText: oldRule, newText: newRule }] },
              },
              { name: "read", args: { path: skillFile } },
              { name: "read", args: { path: supportFile } },
            ];
            gateway = await startGatewayWithClient({
              cfg: config,
              configPath: state.configPath,
              token,
              scopes: ["operator.admin", "operator.read", "operator.write"],
            });
            const sessionKey = "agent:main:workshop-learning-proof";
            const accepted = await gateway.client.request<{ runId: string; status: string }>(
              "agent",
              {
                sessionKey,
                message:
                  "Check the nine release receipts individually. For future map publications, correct the reusable procedure: a green health check is insufficient; confirm the public generation matches the release.",
                deliver: false,
                idempotencyKey: randomUUID(),
              },
            );
            expect(accepted.status).toBe("accepted");
            const completed = await gateway.client.request<{ status: string }>(
              "agent.wait",
              { runId: accepted.runId, timeoutMs: 45_000 },
              { timeoutMs: 50_000 },
            );
            expect(completed.status).toBe("ok");
            expect(foregroundRequests).toBe(10);
            const scope = {
              agentId: "main",
              sessionKey,
              storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
            };
            const sourceEntry = loadSessionEntry(scope);
            if (!sourceEntry) {
              throw new Error("The completed foreground session is missing.");
            }
            const source = { ...scope, sessionId: sourceEntry.sessionId };
            const originalTranscript = loadTranscriptEventsSync(source);
            await withTestTimeout(
              reviewStarted.promise,
              45_000,
              "The idle Workshop review did not reach the provider.",
            );
            let continuedTranscript: typeof originalTranscript;
            try {
              const laterAccepted = await gateway.client.request<{ runId: string; status: string }>(
                "agent",
                {
                  sessionKey,
                  message: laterMessage,
                  deliver: false,
                  idempotencyKey: randomUUID(),
                },
              );
              expect(laterAccepted.status).toBe("accepted");
              const laterCompleted = await gateway.client.request<{ status: string }>(
                "agent.wait",
                { runId: laterAccepted.runId, timeoutMs: 30_000 },
                { timeoutMs: 35_000 },
              );
              console.log(
                "WORKSHOP_GATEWAY_OVERLAP_OBSERVATION",
                JSON.stringify({
                  accepted,
                  completed,
                  laterAccepted,
                  laterCompleted,
                  source,
                  sourceEntry: loadSessionEntry(scope),
                  originalTranscript,
                  currentTranscript: loadTranscriptEventsSync(source),
                  providerRequests,
                  laterForegroundRequests,
                  reviewRequests,
                  providerErrors,
                }),
              );
              expect(laterCompleted.status).toBe("ok");
              expect(laterForegroundRequests).toHaveLength(1);
              expect(reviewRequests).toHaveLength(1);
              continuedTranscript = loadTranscriptEventsSync(source);
            } finally {
              releaseReview.resolve();
            }
            expect(continuedTranscript.slice(0, originalTranscript.length)).toEqual(
              originalTranscript,
            );
            const laterTranscript = JSON.stringify(
              continuedTranscript.slice(originalTranscript.length),
            );
            expect(laterTranscript).toContain(laterMessage);
            expect(laterTranscript).toContain(laterReply);
            await expect
              .poll(() => Object.values(readSkillReviewOutcomes().experienceReviews).length, {
                timeout: 80_000,
                interval: 100,
              })
              .toBe(1);
            const skill = await fs.readFile(skillFile, "utf8");
            const support = await fs.readFile(supportFile, "utf8");
            const outside = await fs.readFile(outsideFile, "utf8");
            const finalTranscript = loadTranscriptEventsSync(source);
            console.log(
              "WORKSHOP_GATEWAY_LEARNING_EVIDENCE",
              JSON.stringify({
                foregroundRequests,
                providerRequests,
                laterForegroundRequests,
                reviewRequests,
                outcomes: readSkillReviewOutcomes().experienceReviews,
                originalSkill,
                originalSupport,
                skill,
                support,
                outsideContent,
                outside,
                originalTranscript,
                continuedTranscript,
                finalTranscript,
              }),
            );
            expect(providerErrors).toEqual([]);
            expect(reviewRequests).toHaveLength(reviewActions.length + 1);
            const outsideResult = reviewRequests[1]?.input?.findLast(
              (item) => item.type === "function_call_output",
            );
            expect(outsideResult?.output).toContain("Path escapes sandbox root");
            expect(outside).toBe(outsideContent);
            for (const reviewRequest of reviewRequests) {
              const evidence = JSON.stringify(reviewRequest);
              expect(evidence).not.toContain(laterMessage);
              expect(evidence).not.toContain(outsideContent.trim());
            }
            expect(finalTranscript).toEqual(continuedTranscript);
            expect(skill).toBe(originalSkill.replace(oldRule, newRule));
            expect(support).toBe(originalSupport.replace(oldRule, newRule));
          },
        );
      } finally {
        releaseReview.resolve();
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "Workshop learning proof cleanup" });
        }
        await state.cleanup();
      }
    },
  );
});
