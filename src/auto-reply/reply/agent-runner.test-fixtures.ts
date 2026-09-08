// Shared fixtures for agent runner tests and temporary session files.
import path from "node:path";
import { onTestFinished } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  hasInternalRuntimeContext,
  stripInternalRuntimeContext,
} from "../../agents/internal-runtime-context.js";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";

type FollowupRunFixture = Pick<FollowupRun, "prompt" | "summaryLine" | "enqueuedAt"> &
  Partial<Omit<FollowupRun, "prompt" | "summaryLine" | "enqueuedAt" | "run">> & {
    run: Partial<Omit<FollowupRun["run"], "skillsSnapshot">> & {
      skillsSnapshot?: Partial<FollowupRun["run"]["skillsSnapshot"]>;
    };
  };

export function isModelRuntimeContextCarrier(message: { role: string; content: unknown }): boolean {
  const text =
    extractTextFromChatContent(message.content, {
      joinWith: "\n",
      normalizeText: (value) => value,
    }) ?? "";
  return (
    message.role === "user" &&
    hasInternalRuntimeContext(text) &&
    !stripInternalRuntimeContext(text).trim()
  );
}

export function createTestTemplateContext(
  overrides: Partial<TemplateContext> = {},
): TemplateContext {
  return { ...overrides };
}

export function createTestQueueSettings(overrides: Partial<QueueSettings> = {}): QueueSettings {
  return { mode: "interrupt", ...overrides };
}

export function createTestFollowupRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun {
  const rootDir = useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-followup-run-");
  return {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: path.join(rootDir, "agent"),
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: path.join(rootDir, "session.jsonl"),
      workspaceDir: rootDir,
      config: {},
      skillsSnapshot: { prompt: "", skills: [] },
      provider: "anthropic",
      model: "claude",
      thinkingCatalog: [
        {
          provider: overrides.provider ?? "anthropic",
          id: overrides.model ?? "claude",
          input: ["text"],
        },
      ],
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      skipProviderRuntimeHints: true,
      ...overrides,
    },
  } satisfies FollowupRun;
}

export function createTestQueuedFollowupRun(fixture: FollowupRunFixture): FollowupRun {
  return fixture as FollowupRun;
}

export function withTestModelContextTokens(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  defaultModel: string;
  contextTokens?: number;
}): OpenClawConfig {
  if (params.contextTokens === undefined) {
    return params.cfg;
  }
  const provider = params.followupRun.run.provider;
  const model = params.followupRun.run.model ?? params.defaultModel;
  const providerConfig = params.cfg.models?.providers?.[provider];
  const configuredModels = providerConfig?.models ?? [];
  const configuredModel = configuredModels.find((entry) => entry.id === model);
  return {
    ...params.cfg,
    models: {
      ...params.cfg.models,
      providers: {
        ...params.cfg.models?.providers,
        [provider]: {
          ...providerConfig,
          models: [
            ...configuredModels.filter((entry) => entry.id !== model),
            { ...configuredModel, id: model, contextTokens: params.contextTokens },
          ],
        },
      },
    },
  } as OpenClawConfig;
}

export async function writeTestSessionStore(
  storePath: string,
  sessionKey: string,
  entry: SessionEntry,
): Promise<void> {
  const fileEntry = entry as SessionEntry & { sessionFile?: string; transcriptPath?: string };
  if (fileEntry.sessionFile) {
    fileEntry.transcriptPath = fileEntry.sessionFile;
    delete fileEntry.sessionFile;
  }
  await replaceSessionEntry({ storePath, sessionKey }, entry);
}
