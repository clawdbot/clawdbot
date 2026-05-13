import fs from "node:fs/promises";
import os from "node:os";
import { scrubConfigAuditLog } from "../config/io.audit.js";
import { note } from "../terminal/note.js";

const NOTE_TITLE = "Config audit";

function formatEntryCount(count: number): string {
  return `${count} ${count === 1 ? "entry" : "entries"}`;
}

export async function maybeScrubConfigAuditLog(params: {
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  doctorFixCommand?: string;
}): Promise<void> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const scrubFs = { promises: fs };

  try {
    if (params.shouldRepair) {
      const result = await scrubConfigAuditLog({ fs: scrubFs, env, homedir });
      if (result.aborted) {
        note(
          "Config audit scrub was aborted because new entries were appended to config-audit.jsonl during the rewrite. No records were modified. Stop the gateway (or wait until it is idle) and rerun `openclaw doctor --fix`.",
          NOTE_TITLE,
        );
        return;
      }
      if (result.rewritten > 0) {
        note(
          `Scrubbed ${formatEntryCount(result.rewritten)} in config-audit.jsonl that still contained pre-redactor argv values. Rotate any credentials that may have been written to the log before the forward redactor shipped.`,
          NOTE_TITLE,
        );
      }
      return;
    }

    const preview = await scrubConfigAuditLog({ fs: scrubFs, env, homedir, dryRun: true });
    if (preview.rewritten > 0) {
      const fixCommand = params.doctorFixCommand ?? "openclaw doctor --fix";
      note(
        `${formatEntryCount(preview.rewritten)} in config-audit.jsonl still contain pre-redactor argv values (likely plaintext credentials at rest). Run \`${fixCommand}\` to rewrite the argv/execArgv fields through the same redactor used for new entries.`,
        NOTE_TITLE,
      );
    }
  } catch (err) {
    note(
      `Config audit scrub failed: ${err instanceof Error ? err.message : String(err)}`,
      NOTE_TITLE,
    );
  }
}
