import fs from "node:fs/promises";
import type { Command } from "commander";
import {
  mutateConfigFile,
  readConfigFileSnapshotForWrite,
} from "openclaw/plugin-sdk/config-mutation";
import { createClackPrompter } from "openclaw/plugin-sdk/setup-runtime";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  applyApprovalMigration,
  listLegacyApprovalItems,
  type ApprovalMigrationDecision,
} from "./approvals-migration.js";

type MigrationOptions = {
  dryRun?: boolean;
  json?: boolean;
};

function readPluginConfig(config: unknown): Record<string, unknown> | null {
  const root = asNullableRecord(config);
  const plugins = asNullableRecord(root?.plugins);
  const entries = asNullableRecord(plugins?.entries);
  const entry = asNullableRecord(entries?.["file-transfer"]);
  return asNullableRecord(entry?.config);
}

async function runApprovalMigration(options: MigrationOptions): Promise<void> {
  const prepared = await readConfigFileSnapshotForWrite();
  if (!prepared.snapshot.valid) {
    throw new Error("OpenClaw config is invalid; fix it before migrating file-transfer approvals");
  }
  const sourceRoot = asNullableRecord(prepared.snapshot.sourceConfig);
  if (asNullableRecord(sourceRoot?.gateway)?.mode === "remote") {
    throw new Error(
      "This migration must run on the Gateway host because it updates that host's file-transfer policy.",
    );
  }
  const pluginConfig = readPluginConfig(prepared.snapshot.sourceConfig);
  const items = listLegacyApprovalItems(pluginConfig);
  if (items.length === 0) {
    const result = { status: "ok", changed: false, message: "No legacy permissions need review." };
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${result.message}\n`);
    return;
  }

  if (options.json || !process.stdin.isTTY) {
    const result = {
      status: "needs-input",
      changed: false,
      items,
      command: "openclaw file-transfer approvals migrate",
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    throw new Error(
      "File-transfer permissions need interactive review. Run `openclaw file-transfer approvals migrate` in a terminal.",
    );
  }

  const prompt = createClackPrompter();
  await prompt.intro("Review file-transfer permissions");
  await prompt.note(
    "Older positive permissions remain inactive until this review finishes. Deny rules and transfer limits remain active.",
  );
  const decisions: ApprovalMigrationDecision[] = [];
  for (const item of items) {
    if (item.selector === "*") {
      decisions.push({ item, action: "keep-glob" });
      continue;
    }
    const action = await prompt.select({
      message: `${item.selector} · ${item.kind} · ${item.path}`,
      options: [
        {
          value: "exact" as const,
          label: "Require exact reapproval",
          hint: "Next use prompts once, then binds the actual node and command",
        },
        {
          value: "keep-glob" as const,
          label: "Keep as an intentional wildcard",
          hint: "Retains the current glob behavior",
        },
        { value: "remove" as const, label: "Remove this permission" },
      ],
    });
    decisions.push({ item, action });
  }

  const keepCount = decisions.filter((decision) => decision.action === "keep-glob").length;
  const exactCount = decisions.filter((decision) => decision.action === "exact").length;
  const removeCount = decisions.filter((decision) => decision.action === "remove").length;
  await prompt.note(
    `Exact paths requiring one reapproval: ${exactCount}\nIntentional wildcards: ${keepCount}\nRemoved: ${removeCount}`,
    "Migration plan",
  );
  await prompt.note(
    "Older OpenClaw versions cannot read the migrated format. To downgrade, restore the adjacent config backup shown after migration before starting the older version.",
    "Downgrade",
  );
  if (options.dryRun) {
    await prompt.outro("Dry run complete. No config was changed.");
    return;
  }
  if (!(await prompt.confirm({ message: "Apply this migration?", initialValue: true }))) {
    await prompt.outro("Cancelled. No config was changed.");
    return;
  }

  const migrated = applyApprovalMigration(pluginConfig, decisions);
  const backupPath = `${prepared.snapshot.path}.bak`;
  const backupBefore = await fs.stat(backupPath).catch(() => null);
  await mutateConfigFile({
    base: "source",
    baseHash: prepared.snapshot.hash,
    writeOptions: prepared.writeOptions,
    afterWrite: { mode: "none", reason: "file-transfer approval policy migration" },
    mutate: (draft) => {
      const plugins = (draft.plugins ??= {});
      const entries = (plugins.entries ??= {});
      const entry = (entries["file-transfer"] ??= {});
      entry.config = migrated;
    },
  });
  const backupAfter = await fs.stat(backupPath).catch(() => null);
  const backupVerified = Boolean(
    backupAfter &&
    (!backupBefore ||
      backupAfter.ino !== backupBefore.ino ||
      backupAfter.mtimeMs !== backupBefore.mtimeMs ||
      backupAfter.size !== backupBefore.size),
  );
  await prompt.outro(
    backupVerified
      ? `File-transfer permissions updated. Exact paths will prompt once on next use. Config backup: ${backupPath}`
      : "File-transfer permissions updated. Exact paths will prompt once on next use. The standard config backup could not be verified.",
  );
}

export function registerFileTransferCli(program: Command): void {
  const root = program
    .command("file-transfer")
    .description("Review file-transfer standing approvals");
  const approvals = root.command("approvals").description("Manage standing approvals");
  approvals
    .command("migrate")
    .description("Review and migrate older file-transfer permissions")
    .option("--dry-run", "Review choices without changing config", false)
    .option("--json", "Report unresolved legacy permissions as JSON", false)
    .action(async (options: MigrationOptions) => {
      await runApprovalMigration(options);
    });
}
