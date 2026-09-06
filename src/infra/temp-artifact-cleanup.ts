import fs from "node:fs/promises";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage } from "./errors.js";
import { runBestEffortCleanup } from "./non-fatal-cleanup.js";

const log = createSubsystemLogger("infra:temp-artifacts");

// Only disposable filesystem artifacts are advisory. Call after resource release;
// failed deletion must preserve the primary result, including cancellation/timeouts.
export function removeTemporaryArtifacts(directory: string, owner: string): Promise<void> {
  return runBestEffortCleanup({
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
    onError: (error) =>
      log.warn(
        truncateUtf16Safe(
          formatErrorMessage(
            `${owner} cleanup failed; files may remain in ${directory}. After the worker or session stops, check permissions and remove the retained directory: ${formatErrorMessage(error)}`,
          ),
          1_024,
        ),
      ),
  });
}
