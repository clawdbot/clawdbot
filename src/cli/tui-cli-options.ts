// Shared Gateway connection options for terminal attach commands.
import type { Command } from "commander";

/** Add the shared Gateway connection flags used by terminal attach commands. */
export function addTuiOptions(command: Command): Command {
  return command
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (if required)")
    .option("--tls-fingerprint <sha256>", "Expected Gateway TLS certificate fingerprint");
}
