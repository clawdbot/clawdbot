import crypto from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";

// Shared logging helpers for CLI backend diagnostics.
export const cliBackendLog = createSubsystemLogger("agent/cli-backend");
export const CLI_BACKEND_LOG_OUTPUT_ENV = "OPENCLAW_CLI_BACKEND_LOG_OUTPUT";
export const LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV = "OPENCLAW_CLAUDE_CLI_LOG_OUTPUT";

/** Return a compact byte/hash summary for CLI backend output. */
export function formatCliBackendOutputDigest(text: string): string {
  const outBytes = Buffer.byteLength(text, "utf8");
  const outHash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
  return `outBytes=${outBytes} outHash=${outHash}`;
}
