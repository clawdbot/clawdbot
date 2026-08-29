import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redactAgentDiagnosticPayload } from "../../agents/diagnostic-redaction.js";
import { isLiveTestEnabled } from "../../agents/live-test-helpers.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import {
  sanitizeToolCallInputs,
  sanitizeToolUseResultPairingForModel,
} from "../../agents/session-transcript-repair.js";
import { SessionManager } from "../../agents/sessions/index.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import { createSessionEntryWithTranscript } from "../../config/sessions/session-accessor.js";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import type { Message } from "../../llm/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { readSkillReviewOutcomes } from "./collection-review-state.js";
import { runSkillExperienceReview, type ExperienceReviewCandidate } from "./experience-review.js";
import { listSkillProposals } from "./service.js";

const LIVE =
  isLiveTestEnabled(["OPENCLAW_LIVE_SKILL_EXPERIENCE_REVIEW"]) &&
  Boolean(process.env.OPENAI_API_KEY?.trim());
const describeLive = LIVE ? describe : describe.skip;
const modelId = process.env.OPENCLAW_LIVE_SKILL_EXPERIENCE_MODEL ?? "gpt-5.6-luna";
const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
let workspaceDir = "";
const reviewDiagnostics = new Map<string, unknown>();
const unsubscribeDiagnostics = LIVE
  ? onAgentRuntimeEvent((event) => {
      if (
        !event.runId.startsWith("skill-workshop-review:") ||
        !["assistant", "tool", "lifecycle", "error"].includes(event.stream)
      ) {
        return;
      }
      const phase = typeof event.data.phase === "string" ? event.data.phase : "";
      const toolCallId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : "";
      const key = `${event.runId}:${event.stream}:${phase}:${toolCallId}`;
      if (reviewDiagnostics.size < 100 || reviewDiagnostics.has(key)) {
        reviewDiagnostics.set(key, {
          runId: event.runId,
          stream: event.stream,
          data: redactAgentDiagnosticPayload(event.data),
        });
      }
    })
  : () => undefined;

function assistantText(text: string) {
  return makeAgentAssistantMessage({ model: modelId, content: [{ type: "text", text }] });
}

function toolRound(
  id: string,
  name: string,
  args: Record<string, unknown>,
  text: string,
  isError = false,
): Message[] {
  return [
    makeAgentAssistantMessage({
      model: modelId,
      stopReason: "toolUse",
      content: [{ type: "toolCall", id, name, arguments: args }],
    }),
    {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text }],
      isError,
      timestamp: 0,
    },
  ];
}

function positiveMessages(): Message[] {
  return [
    makeAgentUserMessage({
      content:
        "Deploy this repository from its checked-in manifest. Do not ask for values already present there.",
    }),
    ...toolRound("deploy-project", "exec", { command: "deploy" }, "project required", true),
    ...toolRound(
      "deploy-region",
      "exec",
      { command: "deploy --project app" },
      "region required",
      true,
    ),
    ...toolRound(
      "deploy-service",
      "exec",
      { command: "deploy --project app --region us" },
      "service required",
      true,
    ),
    assistantText("I am still guessing required fields one at a time."),
    ...toolRound(
      "read-manifest",
      "read",
      { path: "deploy.json" },
      "project=app region=us service=api health=/ready",
    ),
    assistantText("The manifest contains all required deployment inputs."),
    ...toolRound(
      "deploy-complete",
      "exec",
      { command: "deploy --project app --region us --service api" },
      "deployed",
    ),
    ...toolRound("fetch-health", "exec", { command: "fetch /ready" }, "200 ok"),
    assistantText("Deployment verified."),
    assistantText("Next time the manifest should be read before the first deploy call."),
    assistantText("That preflight would remove three failed tool rounds."),
    assistantText("Done."),
  ];
}

function negativeMessages(): Message[] {
  return [
    makeAgentUserMessage({
      content:
        "One-time audit: check these ten unrelated opaque receipts. Policy requires one signed lookup per receipt; no batching or reuse is possible.",
    }),
    ...Array.from({ length: 10 }, (_, index) =>
      toolRound(
        `receipt-${index + 1}`,
        "exec",
        { command: `signed_receipt_lookup --id ${index + 1}` },
        "valid",
      ),
    ).flat(),
    assistantText("All ten one-time receipts are valid."),
  ];
}

function interruptedMessages(): Message[] {
  // Copying only a WAL-mode main file can pass integrity_check while missing
  // committed rows. This recovery was reproduced against SQLite's backup API.
  return [
    makeAgentUserMessage({
      content:
        "Back up the running SQLite event database, verify the backup, then update the operations guide.",
    }),
    ...toolRound(
      "copy-backup",
      "exec",
      { command: "cp events.db backup.db && python3 verify-backup.py events.db backup.db" },
      "source events=3; backup events=0; backup integrity_check=ok; verification failed: committed events missing",
      true,
    ),
    ...toolRound(
      "copy-backup-retry",
      "exec",
      { command: "cp events.db backup.db && python3 verify-backup.py events.db backup.db" },
      "source events=3; backup events=0; backup integrity_check=ok; verification failed: committed events missing",
      true,
    ),
    ...toolRound(
      "inspect-journal",
      "exec",
      {
        command:
          "sqlite3 events.db 'PRAGMA journal_mode; SELECT count(*) FROM events;' && ls events.db*",
      },
      "wal\n3\nevents.db events.db-shm events.db-wal",
    ),
    assistantText(
      "The committed events are still in the WAL. A valid main-file copy is not a complete snapshot.",
    ),
    ...toolRound(
      "read-backup-api",
      "read",
      { path: "docs/sqlite-online-backup.md" },
      "https://sqlite.org/backup.html: The online backup API copies a database into a consistent snapshot while the source remains in use. Python sqlite3.Connection.backup exposes that API.",
    ),
    ...toolRound(
      "online-backup",
      "exec",
      {
        command:
          'python3 -c \'import sqlite3; source=sqlite3.connect("events.db"); target=sqlite3.connect("snapshot.db"); source.backup(target); target.close(); source.close()\'',
      },
      "exit code 0",
    ),
    ...toolRound(
      "verify-snapshot",
      "exec",
      { command: "python3 verify-backup.py events.db snapshot.db" },
      "source events=3; backup events=3; backup integrity_check=ok; verification passed",
    ),
    assistantText(
      "The online backup contains all committed events and passes the integrity check while the source remains open. Moving on to the operations guide.",
    ),
    makeAgentAssistantMessage({
      model: modelId,
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "read-operations-guide",
          name: "read",
          arguments: { path: "OPERATIONS.md" },
        },
      ],
    }),
  ];
}

beforeAll(async () => {
  // Full home isolation: the embedded review resolves the shared-main auth
  // store via HOME, and a real ~/.openclaw with pending doctor migration
  // must never leak into (or fail) this live run.
  testState = await createOpenClawTestState({
    layout: "home",
    prefix: "openclaw-live-skill-review-state-",
  });
  workspaceDir = await tempDirs.make("openclaw-live-skill-review-workspace-");
});

afterAll(async () => {
  unsubscribeDiagnostics();
  if (LIVE) {
    console.log("WORKSHOP_RUNTIME_DIAGNOSTICS", JSON.stringify([...reviewDiagnostics.values()]));
    console.log(
      "WORKSHOP_REVIEW_OUTCOMES",
      JSON.stringify(readSkillReviewOutcomes().experienceReviews),
    );
  }
  await testState.cleanup();
  await tempDirs.cleanup();
});

async function candidate(
  runId: string,
  messages: Message[],
  options: { turnAborted?: boolean } = {},
): Promise<ExperienceReviewCandidate> {
  const sessionId = `live-skill-review-${runId}`;
  const sessionKey = `agent:main:${sessionId}`;
  const result: ExperienceReviewCandidate = {
    ctx: {
      agentId: "main",
      runId,
      sessionId,
      sessionKey,
      workspaceDir,
      modelProviderId: "openai",
      modelId,
      foregroundPromptContext: {
        agentId: "main",
        agentDir: workspaceDir,
        workspaceDir,
        cwd: workspaceDir,
        sandboxSessionKey: sessionKey,
        trigger: "user",
      },
    },
    config: {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            agentRuntime: { id: "openclaw" },
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: modelId,
                name: modelId,
                api: "openai-responses",
                agentRuntime: { id: "openclaw" },
                input: ["text"],
                reasoning: true,
                contextWindow: 1_047_576,
                maxTokens: 2_048,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      agents: {
        entries: { main: { default: true } },
        defaults: {
          model: { primary: `openai/${modelId}` },
          models: {
            [`openai/${modelId}`]: {
              agentRuntime: { id: "openclaw" },
              params: { maxTokens: 2_048 },
            },
          },
        },
      },
      skills: { workshop: { autonomous: { mode: "propose" } } },
      // Only the OpenAI provider plugin is needed. A cold unrestricted load
      // compiles all bundled extensions and runs provider discovery inside the
      // review lane, which can exceed the lane's no-progress watchdog.
      plugins: { allow: ["openai"] },
    },
    ...(options.turnAborted === undefined ? {} : { turnAborted: options.turnAborted }),
  };
  const target = await resolveAgentRunSessionTarget({
    agentId: "main",
    config: result.config,
    missingSessionKey: "create",
    sessionId,
    sessionKey,
  });
  const created = await createSessionEntryWithTranscript(
    target,
    () => ({ ok: true, entry: { sessionId, updatedAt: Date.now() } }),
    { cwd: workspaceDir },
  );
  if (!created.ok) {
    throw new Error(`Failed to create live review session: ${created.error}`);
  }
  for (const message of messages) {
    SessionManager.appendMessageToTranscript(target, message, { config: result.config });
  }
  return result;
}

describe("skill experience review transcript fixture", () => {
  it.each([
    ["positive", positiveMessages],
    ["negative", negativeMessages],
    ["interrupted", interruptedMessages],
  ] as const)("preserves %s evidence through canonical transcript replay", async (name, build) => {
    const runId = `transcript-fixture-${name}`;
    const sessionId = `live-skill-review-${runId}`;
    const sessionKey = `agent:main:${sessionId}`;
    const messages = build();
    const seeded = await candidate(runId, messages);
    const target = await resolveAgentRunSessionTarget({
      agentId: "main",
      config: seeded.config,
      missingSessionKey: "resolve-existing",
      sessionId,
      sessionKey,
    });
    const stored = SessionManager.open(target, workspaceDir).buildSessionContext().messages;
    expect(stored).toEqual(messages);

    // The review replays native tools. Invented tool names lose their calls
    // and orphaned results, removing the recovery evidence from the evaluation.
    const replay = sanitizeToolUseResultPairingForModel(
      sanitizeToolCallInputs(stored, { allowedToolNames: ["exec", "read", "skill_workshop"] }),
      true,
    );
    expect(replay.filter((message) => message.role === "toolResult")).toEqual(
      expect.arrayContaining(messages.filter((message) => message.role === "toolResult")),
    );
  });
});

describeLive("skill experience review live OpenAI eval", () => {
  beforeAll(async () => {
    // Warm the plugin runtime outside the review lane: the first load compiles
    // extensions synchronously and can exceed the lane's no-progress watchdog
    // on a loaded machine.
    const { loadAgentRuntimePluginRegistryHandle } =
      await import("../../agents/runtime-plugins.js");
    const warmupCandidate = await candidate("warmup", []);
    loadAgentRuntimePluginRegistryHandle({
      config: warmupCandidate.config ?? {},
      workspaceDir,
    });
  }, 600_000);

  it("proposes a recovered preflight procedure but ignores routine one-off work", async () => {
    const positiveCandidate = await candidate("live-positive", positiveMessages());
    await runSkillExperienceReview(positiveCandidate, {
      getCurrentConfig: () => positiveCandidate.config ?? {},
    });
    const afterPositive = await listSkillProposals({ workspaceDir });
    expect(afterPositive.proposals).toHaveLength(1);
    expect(afterPositive.proposals[0]).toMatchObject({ status: "pending" });

    const negativeCandidate = await candidate("live-negative", negativeMessages());
    await runSkillExperienceReview(negativeCandidate, {
      getCurrentConfig: () => negativeCandidate.config ?? {},
    });
    const afterNegative = await listSkillProposals({ workspaceDir });
    expect(afterNegative.proposals).toEqual(afterPositive.proposals);

    const interruptedCandidate = await candidate("live-interrupted", interruptedMessages(), {
      turnAborted: true,
    });
    await runSkillExperienceReview(interruptedCandidate, {
      getCurrentConfig: () => interruptedCandidate.config ?? {},
    });
    const afterInterrupted = await listSkillProposals({ workspaceDir });
    expect(afterInterrupted.proposals.length).toBeGreaterThan(afterNegative.proposals.length);
  }, 300_000);
});
