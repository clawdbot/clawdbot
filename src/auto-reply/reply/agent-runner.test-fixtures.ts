// Shared fixtures for agent runner tests and temporary session files.
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FollowupRun } from "./queue.js";

export function createTestFollowupRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun {
  return {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: { prompt: "", skills: [] },
      provider: "anthropic",
      model: "claude",
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
