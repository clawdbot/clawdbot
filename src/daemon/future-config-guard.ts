/** Prevents daemon write actions when the config belongs to a newer OpenClaw. */
import {
  formatFutureConfigActionBlock,
  resolveFutureConfigActionBlock,
  type FutureConfigActionBlock,
} from "../config/future-version-guard.js";

/** Resolves whether the running config was last written by a newer OpenClaw. */
export async function readFutureConfigActionBlock(
  action: string,
): Promise<FutureConfigActionBlock | null> {
  const { readConfigFileSnapshot } = await import("../config/io.runtime.js");
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
