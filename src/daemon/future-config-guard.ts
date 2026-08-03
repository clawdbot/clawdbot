/** Prevents daemon write actions when the config belongs to a newer OpenClaw. */
import { readConfigFileSnapshot } from "../config/config.js";
import {
  formatFutureConfigActionBlock,
  resolveFutureConfigActionBlock,
  type FutureConfigActionBlock,
} from "../config/future-version-guard.js";

// Blocks daemon mutations when config was written by a newer OpenClaw.
async function readFutureConfigActionBlock(
  action: string,
  env?: Record<string, string | undefined>,
): Promise<FutureConfigActionBlock | null> {
  try {
    const snapshot = await readConfigFileSnapshot();
    return resolveFutureConfigActionBlock({ action, snapshot, env });
  } catch {
    return null;
  }
}

export async function assertFutureConfigActionAllowed(
  action: string,
  env?: Record<string, string | undefined>,
): Promise<void> {
  const block = await readFutureConfigActionBlock(action, env);
  if (block) {
    throw new Error(formatFutureConfigActionBlock(block));
  }
}
