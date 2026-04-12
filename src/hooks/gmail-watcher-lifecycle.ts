import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { startGmailWatcher } from "./gmail-watcher.js";

export type GMailWatcherLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export async function startGmailWatcherWithLogs(params: {
  cfg: OpenClawConfig;
  log: GMailWatcherLog;
  onSkipped?: () => void;
}) {
  if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_GMAIL_WATCHER)) {
    params.onSkipped?.();
    return;
  }

  try {
    const gmailResult = await startGmailWatcher(params.cfg);
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
