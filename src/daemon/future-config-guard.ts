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
): Promise<FutureConfigActionBlock | null> {
  try {
    const snapshot = await readConfigFileSnapshot();
    return resolveFutureConfigActionBlock({ action, snapshot });
  } catch {
    return null;
  }
}

export async function assertFutureConfigActionAllowed(action: string): Promise<void> {
  const block = await readFutureConfigActionBlock(action);
  if (block) {
    throw new Error(formatFutureConfigActionBlock(block));
  }
}
