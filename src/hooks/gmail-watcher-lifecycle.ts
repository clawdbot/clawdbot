// Gmail watcher lifecycle helpers manage watcher process state from config.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { startGmailWatcher } from "./gmail-watcher.js";

/** Logging surface used while starting the Gmail watcher during gateway startup. */
type GMailWatcherLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

/** Start the Gmail watcher with startup logs and env-based skip handling. */
export async function startGmailWatcherWithLogs(params: {
  cfg: OpenClawConfig;
  log: GMailWatcherLog;
  onSkipped?: () => void;
  isCancelled?: () => boolean;
  signal?: AbortSignal;
}) {
  if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_GMAIL_WATCHER)) {
    // Test and local recovery paths use the env skip to avoid starting a long
    // lived watcher while still exercising gateway startup.
    params.onSkipped?.();
    return;
  }

  try {
    const gmailResult = await startGmailWatcher(params.cfg, {
      isCancelled: params.isCancelled,
      signal: params.signal,
    });
    if (gmailResult.started) {
      params.log.info("gmail watcher started");
      return;
    }
    if (
      gmailResult.reason &&
      gmailResult.reason !== "hooks not enabled" &&
      gmailResult.reason !== "no gmail account configured"
    ) {
      params.log.warn(`gmail watcher not started: ${gmailResult.reason}`);
    }
  } catch (err) {
    params.log.error(`gmail watcher failed to start: ${String(err)}`);
  }
}
