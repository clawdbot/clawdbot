/** Runtime facade for config-driven reply resolution. */
import { prewarmReplyRunRuntimes } from "./get-reply-run-helpers.js";
import { getReplyFromConfig } from "./get-reply.js";

export { getReplyFromConfig };

export async function prewarmConfigDrivenReplyRuntime(): Promise<void> {
  await prewarmReplyRunRuntimes();
}
