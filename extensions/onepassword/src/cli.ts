import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { AuditRow } from "./broker.js";
import type { OnePasswordConfig } from "./config.js";
import type { OpClient } from "./op-client.js";

type CommandLike = {
  command(name: string): CommandLike;
  description(value: string): CommandLike;
  option(flags: string, description: string, defaultValue?: string): CommandLike;
  action<TOptions>(fn: (options: TOptions) => void | Promise<void>): CommandLike;
};

type OnePasswordCliContext = {
  program: CommandLike;
  resolveConfig: () => OnePasswordConfig | undefined;
  resolveOpClient: () => Pick<OpClient, "opBin" | "tokenFilePresent">;
  auditStore: PluginStateKeyedStore<AuditRow>;
  write?: (message: string) => void;
};

function parseLimit(value: unknown): number {
  if (value === undefined) {
    return 50;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined || parsed > 1000) {
    throw new Error("--limit must be an integer from 1 to 1000");
  }
  return parsed;
}

function truncateReason(reason: string): string {
  return reason.length <= 80 ? reason : `${truncateUtf16Safe(reason, 77)}...`;
}

async function buildStatus(
  config: OnePasswordConfig | undefined,
  opClient: Pick<OpClient, "opBin" | "tokenFilePresent">,
) {
  const policies = { auto: 0, approve: 0, deny: 0 };
  for (const item of Object.values(config?.items ?? {})) {
    policies[item.policy] += 1;
  }
  return {
    tokenFilePresent: await opClient.tokenFilePresent(),
    opBinaryResolved: Boolean(opClient.opBin),
    opBinaryPath: opClient.opBin ?? null,
    itemCount: Object.keys(config?.items ?? {}).length,
    policyCounts: policies,
  };
}

async function readAuditRows(auditStore: PluginStateKeyedStore<AuditRow>, limit: number) {
  return (await auditStore.entries())
    .toSorted(
      (left, right) =>
        right.value.timestampMs - left.value.timestampMs || right.key.localeCompare(left.key),
    )
    .slice(0, limit)
    .map(({ value }) => {
      const row: {
        timestamp: string;
        agent: string;
        slug: string;
        outcome: string;
        errorCode?: string;
        reason: string;
      } = {
        timestamp: new Date(value.timestampMs).toISOString(),
        agent: value.agentId,
        slug: value.slug,
        outcome: value.outcome,
        reason: truncateReason(value.reason),
      };
      if (value.errorCode) {
        row.errorCode = value.errorCode;
      }
      return row;
    });
}

export function registerOnePasswordCommands(context: OnePasswordCliContext): void {
  const write = context.write ?? ((message: string) => process.stdout.write(`${message}\n`));
  const command = context.program
    .command("onepassword")
    .description("Inspect the 1Password broker");
  command
    .command("status")
    .description("Show broker readiness without secret values")
    .action(async () => {
      write(
        JSON.stringify(
          await buildStatus(context.resolveConfig(), context.resolveOpClient()),
          null,
          2,
        ),
      );
    });
  command
    .command("audit")
    .description("Show recent 1Password access audit rows")
    .option("--limit <number>", "Maximum rows to print", "50")
    .action(async (options: { limit?: string }) => {
      write(
        JSON.stringify(await readAuditRows(context.auditStore, parseLimit(options.limit)), null, 2),
      );
    });
}
