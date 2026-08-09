/** Runtime facade for config-driven reply resolution. */
import type { PreparedReplyDispatchRuntime } from "../../agents/prepared-model-runtime.types.js";
import { prewarmReplyRunRuntimes } from "./get-reply-run-helpers.js";
import { getReplyFromConfig as resolveReplyFromConfig } from "./get-reply.js";
import { runWithPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";

export function getReplyFromConfig(
  ctx: Parameters<typeof resolveReplyFromConfig>[0],
  opts?: Parameters<typeof resolveReplyFromConfig>[1],
  configOverride?: Parameters<typeof resolveReplyFromConfig>[2],
  preparedReplyDispatchRuntime?: PreparedReplyDispatchRuntime,
): ReturnType<typeof resolveReplyFromConfig> {
  return runWithPreparedReplyDispatchRuntime(preparedReplyDispatchRuntime, () =>
    resolveReplyFromConfig(ctx, opts, configOverride),
  );
}

export async function prewarmConfigDrivenReplyRuntime(): Promise<void> {
  await prewarmReplyRunRuntimes();
}
