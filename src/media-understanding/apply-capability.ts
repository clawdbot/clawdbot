// Keeps one provider failure from blocking the remaining media capabilities.
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { runCapability } from "./runner.js";

export async function runMediaCapability(
  params: Parameters<typeof runCapability>[0],
): Promise<Awaited<ReturnType<typeof runCapability>> | undefined> {
  try {
    return await runCapability(params);
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(`Media understanding task failed: ${String(err)}`);
    }
    return undefined;
  }
}
