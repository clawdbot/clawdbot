import fs from "node:fs/promises";
import path from "node:path";

import type { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveMoltbotPackageRoot } from "./moltbot-root.js";
import { compareSemverStrings, resolveNpmChannelTag, checkUpdateStatus } from "./update-check.js";
import { normalizeUpdateChannel, DEFAULT_PACKAGE_CHANNEL } from "./update-channels.js";
import { VERSION } from "../version.js";
import { formatCliCommand } from "../cli/command-format.js";

type UpdateCheckState = {
  lastCheckedAt?: string;
  lastNotifiedVersion?: string;
  lastNotifiedTag?: string;
};

const UPDATE_CHECK_FILENAME = "update-check.json";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function shouldSkipCheck(allowInTests: boolean): boolean {
  if (allowInTests) return false;
  if (process.env.VITEST || process.env.NODE_ENV === "test") return true;
  return false;
}

async function readState(statePath: string): Promise<UpdateCheckState> {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as UpdateCheckState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(statePath: string, state: UpdateCheckState): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
}

export async function runGatewayUpdateCheck(params: {
  cfg: ReturnType<typeof loadConfig>;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  isNixMode: boolean;
  allowInTests?: boolean;
}): Promise<void> {
  if (shouldSkipCheck(Boolean(params.allowInTests))) return;
  if (params.isNixMode) return;
  if (params.cfg.update?.checkOnStart === false) return;

  const statePath = path.join(resolveStateDir(), UPDATE_CHECK_FILENAME);
  const state = await readState(statePath);
  const now = Date.now();
  const lastCheckedAt = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : null;
  if (lastCheckedAt && Number.isFinite(lastCheckedAt)) {
    if (now - lastCheckedAt < UPDATE_CHECK_INTERVAL_MS) return;
  }

  const root = await resolveMoltbotPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  const status = await checkUpdateStatus({
    root,
    timeoutMs: 2500,
    fetchGit: false,
    includeRegistry: false,
  });

  const nextState: UpdateCheckState = {
    ...state,
    lastCheckedAt: new Date(now).toISOString(),
  };

  if (status.installKind !== "package") {
    await writeState(statePath, nextState);
    return;
  }

  const channel = normalizeUpdateChannel(params.cfg.update?.channel) ?? DEFAULT_PACKAGE_CHANNEL;
  const resolved = await resolveNpmChannelTag({ channel, timeoutMs: 2500 });
  const tag = resolved.tag;
  if (!resolved.version) {
    await writeState(statePath, nextState);
    return;
  }

  const cmp = compareSemverStrings(VERSION, resolved.version);
  if (cmp != null && cmp < 0) {
    const shouldNotify =
      state.lastNotifiedVersion !== resolved.version || state.lastNotifiedTag !== tag;
    if (shouldNotify) {
      params.log.info(
        `update available (${tag}): v${resolved.version} (current v${VERSION}). Run: ${formatCliCommand("moltbot update")}`,
      );
      nextState.lastNotifiedVersion = resolved.version;
      nextState.lastNotifiedTag = tag;
    }
  }

  await writeState(statePath, nextState);
}

export function scheduleGatewayUpdateCheck(params: {
  cfg: ReturnType<typeof loadConfig>;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  isNixMode: boolean;
}): void {
  void runGatewayUpdateCheck(params).catch(() => {});
}
