/** Local recovery retirement. This handler never invokes update or Doctor repair. */
import { confirm, isCancel } from "@clack/prompts";
import {
  inspectSessionSqliteRecovery,
  type RecoveryCleanupReport,
} from "../../commands/doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "../../commands/doctor-session-sqlite-retirement.js";
import { readSourceConfigBestEffort } from "../../config/io.js";
import { defaultRuntime, writeRuntimeJson } from "../../runtime.js";

function renderCleanup(report: RecoveryCleanupReport): void {
  defaultRuntime.log(`Recovery cleanup: ${report.stateDir}`);
  for (const item of report.artifacts) {
    defaultRuntime.log(
      `  ${item.outcome}: ${item.path} (${item.bytes} bytes; ${item.reason})${item.detail ? ` ${item.detail}` : ""}`,
    );
  }
  defaultRuntime.log(
    `Candidates: ${report.totals.candidateBytes} bytes; verification required: ${report.totals.verificationRequiredBytes}; protected: ${report.totals.protectedBytes}; blocked: ${report.totals.blockedBytes}.`,
  );
  defaultRuntime.log(
    "Retiring originals permanently loses rollback, including pre-repair branches and metadata. Logical bytes are not a promise of physical space reclaimed.",
  );
  if (report.artifacts.length === 0) {
    defaultRuntime.log("No recorded recovery artifacts found.");
  }
  if (report.status === "complete") {
    defaultRuntime.log(
      `Removed ${report.totals.removedFiles} files (${report.totals.removedBytes} logical bytes).`,
    );
  }
}

export async function updateCleanupCommand(options: {
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
}): Promise<void> {
  let report: RecoveryCleanupReport | undefined;
  try {
    const readConfig = () => readSourceConfigBestEffort();
    report = inspectSessionSqliteRecovery({ cfg: await readConfig(), env: process.env });
    if (!options.dryRun) {
      if (report.artifacts.length === 0 && !options.yes) {
        report.status = "complete";
      } else if (!options.yes && (options.json || !process.stdin.isTTY || !process.stderr.isTTY)) {
        report.status = "refused";
      } else {
        report = await retireSessionSqliteRecovery({
          env: process.env,
          preview: report,
          readConfig,
          confirm: async (verified) => {
            if (options.yes || verified.artifacts.length === 0) {
              return true;
            }
            renderCleanup(verified);
            const answer = await confirm({
              message: "Permanently retire these rollback originals?",
              initialValue: false,
              output: process.stderr,
            });
            return !isCancel(answer) && answer;
          },
        });
      }
    }
    if (options.json) {
      writeRuntimeJson(defaultRuntime, { ...report, dryRun: options.dryRun === true });
    } else {
      renderCleanup(report);
    }
    if (report.status === "refused") {
      defaultRuntime.error(
        "Nothing removed. Review with `openclaw update cleanup --dry-run`; use --yes to acknowledge permanent rollback loss.",
      );
      defaultRuntime.exit(1);
    } else if (report.status === "blocked") {
      defaultRuntime.exit(1);
    }
  } catch (error) {
    if (options.json) {
      writeRuntimeJson(defaultRuntime, { ...report, status: "blocked", error: String(error) });
    } else {
      defaultRuntime.error(String(error));
    }
    defaultRuntime.exit(1);
  }
}
