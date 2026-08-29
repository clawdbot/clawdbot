import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import { SessionManager } from "../../agents/sessions/index.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import { createSessionEntryWithTranscript } from "../../config/sessions/session-accessor.js";
import type { Message } from "../../llm/types.js";
import type { ExperienceReviewCandidate } from "./experience-review.js";

export function createExperienceReviewMessages(modelId: string) {
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

  return { positiveMessages, negativeMessages, interruptedMessages };
}

export async function createExperienceReviewCandidate(
  runId: string,
  messages: Message[],
  options: {
    workspaceDir: string;
    modelId: string;
    baseUrl?: string;
    apiKey?: string;
    turnAborted?: boolean;
  },
): Promise<ExperienceReviewCandidate> {
  const { workspaceDir, modelId } = options;
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
            apiKey: options.apiKey ?? { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
            ...(options.baseUrl ? { request: { allowPrivateNetwork: true } } : {}),
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
