// Delivery failure command registration.
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import type { Command } from "commander";
import {
  deliveryFailuresListCommand,
  deliveryFailuresPurgeCommand,
  deliveryFailuresResubmitCommand,
} from "../../commands/delivery-failures.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { addGatewayClientOptions } from "../gateway-rpc.js";
import { applyParentDefaultHelpAction } from "./parent-default-help.js";

function parseLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return 100;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined || parsed > 500) {
    throw new Error("--limit must be an integer between 1 and 500");
  }
  return parsed;
}

function addFailureSelectionOptions(command: Command): Command {
  return command
    .option("--queue <namespace>", "Filter by exact physical queue namespace")
    .option("--limit <count>", "Maximum rows (default: 100; maximum: 500)", "100")
    .option("--json", "Output JSON", false);
}

export function registerDeliveryCommand(program: Command): void {
  const delivery = program
    .command("delivery")
    .description("Inspect and maintain durable delivery state");
  const failures = delivery
    .command("failures")
    .description("Inspect, compact, purge, or safely resubmit failed deliveries");

  addFailureSelectionOptions(
    failures
      .command("list")
      .description("List retained failure metadata without payload or route content")
      .option("--exact-ids", "Show exact row identifiers and producer prefixes", false),
  ).action(async (opts) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      deliveryFailuresListCommand(
        {
          queue: opts.queue as string | undefined,
          limit: parseLimit(opts.limit),
          exactIds: Boolean(opts.exactIds),
          json: Boolean(opts.json),
        },
        defaultRuntime,
      );
    });
  });

  addFailureSelectionOptions(
    failures
      .command("purge")
      .description("Preview retention cleanup; compact fences without breaking ownership")
      .option("--apply", "Apply the retention plan", false)
      .option("--yes", "Confirm apply mode non-interactively", false),
  ).action(async (opts) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      await deliveryFailuresPurgeCommand(
        {
          queue: opts.queue as string | undefined,
          limit: parseLimit(opts.limit),
          apply: Boolean(opts.apply),
          yes: Boolean(opts.yes),
          json: Boolean(opts.json),
        },
        defaultRuntime,
      );
    });
  });

  addGatewayClientOptions(
    failures
      .command("resubmit <id>")
      .description("Queue one safe failure for recovery through the running Gateway")
      .option("--queue <namespace>", "Select the exact physical queue namespace")
      .option("--json", "Output JSON", false)
      .option("--exact-ids", "Show the exact identifier instead of its fingerprint", false),
  ).action(async (id, opts) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      await deliveryFailuresResubmitCommand(
        String(id),
        {
          queue: opts.queue as string | undefined,
          url: opts.url as string | undefined,
          token: opts.token as string | undefined,
          password: opts.password as string | undefined,
          timeout: opts.timeout as string | undefined,
          json: Boolean(opts.json),
          exactIds: Boolean(opts.exactIds),
        },
        defaultRuntime,
      );
    });
  });

  applyParentDefaultHelpAction(failures);
  applyParentDefaultHelpAction(delivery);
}
