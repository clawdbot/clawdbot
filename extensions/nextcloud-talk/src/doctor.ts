// Nextcloud Talk plugin module implements doctor behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import { migratePersistentDedupeLegacyJsonFile } from "openclaw/plugin-sdk/persistent-dedupe";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { listNextcloudTalkAccountIds, resolveNextcloudTalkAccount } from "./accounts.js";
import { probeNextcloudTalkBotResponseFeature } from "./bot-preflight.js";
import {
  legacyConfigRules as NEXTCLOUD_TALK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeNextcloudTalkCompatibilityConfig,
} from "./doctor-contract.js";
import {
  NEXTCLOUD_TALK_PLUGIN_ID,
  NEXTCLOUD_TALK_REPLAY_DEDUPE_NAMESPACE_PREFIX,
} from "./replay-guard.js";
import type { CoreConfig } from "./types.js";

const REPLAY_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const REPLAY_DEDUPE_MAX_ENTRIES = 10_000;

function sanitizeLegacyReplaySegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectNextcloudTalkBotResponseWarnings(params: {
  cfg: CoreConfig;
}): Promise<string[]> {
  const warnings: string[] = [];
  for (const accountId of listNextcloudTalkAccountIds(params.cfg)) {
    const account = resolveNextcloudTalkAccount({ cfg: params.cfg, accountId });
    if (!account.enabled || !account.secret || !account.baseUrl) {
      continue;
    }
    const result = await probeNextcloudTalkBotResponseFeature({
      account,
      timeoutMs: 5_000,
    });
    if (
      result.code === "missing_response_feature" ||
      result.code === "bot_not_found" ||
      result.code === "api_error" ||
      result.code === "request_failed"
    ) {
      warnings.push(`- channels.nextcloud-talk.${account.accountId}: ${result.message}`);
    }
  }
  return warnings;
}

async function repairNextcloudTalkReplayDedupeState(params: {
  cfg: CoreConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env, os.homedir);
  const replayDir = path.join(stateDir, "nextcloud-talk", "replay-dedupe");

  for (const accountId of listNextcloudTalkAccountIds(params.cfg)) {
    const legacyPath = path.join(replayDir, `${sanitizeLegacyReplaySegment(accountId)}.json`);
    if (!(await fileExists(legacyPath))) {
      continue;
    }
    try {
      const result = await migratePersistentDedupeLegacyJsonFile({
        filePath: legacyPath,
        namespace: accountId,
        ttlMs: REPLAY_DEDUPE_TTL_MS,
        memoryMaxSize: 0,
        pluginId: NEXTCLOUD_TALK_PLUGIN_ID,
        namespacePrefix: NEXTCLOUD_TALK_REPLAY_DEDUPE_NAMESPACE_PREFIX,
        stateMaxEntries: REPLAY_DEDUPE_MAX_ENTRIES,
        env,
      });
      changes.push(
        `Migrated Nextcloud Talk replay dedupe cache for account "${accountId}" to SQLite (${result.imported} imported, ${result.skippedExpired} expired, ${result.skippedExisting} already current).`,
      );
    } catch (error) {
      warnings.push(
        `Skipped Nextcloud Talk replay dedupe cache for account "${accountId}": ${String(error)}`,
      );
    }
  }

  return { changes, warnings };
}

export const nextcloudTalkDoctor: ChannelDoctorAdapter = {
  legacyConfigRules: NEXTCLOUD_TALK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeNextcloudTalkCompatibilityConfig,
  collectPreviewWarnings: async ({ cfg }) =>
    await collectNextcloudTalkBotResponseWarnings({ cfg: cfg as CoreConfig }),
  repairConfig: async ({ cfg, env }) => {
    const repair = await repairNextcloudTalkReplayDedupeState({
      cfg: cfg as CoreConfig,
      ...(env ? { env } : {}),
    });
    return {
      config: cfg,
      changes: repair.changes,
      warnings: repair.warnings,
    };
  },
};
