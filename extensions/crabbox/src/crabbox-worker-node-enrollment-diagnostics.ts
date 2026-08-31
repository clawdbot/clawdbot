import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import { truncateUtf8Prefix } from "openclaw/plugin-sdk/text-utility-runtime";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";
import { runCrabboxCommand, type CrabboxCommandRunner } from "./crabbox-worker-command.js";

const NODE_ENROLLMENT_DIAGNOSTIC_TIMEOUT_MS = 60_000;
const MAX_NODE_ENROLLMENT_EVIDENCE_BYTES = 2_048;

export async function collectCrabboxNodeEnrollmentEvidence(params: {
  args: string[];
  binary: string;
  id: string;
  runCommand: CrabboxCommandRunner;
  signal?: AbortSignal;
}): Promise<string> {
  let label = "box evidence";
  let detail: string;
  try {
    const result = await runCrabboxCommand({
      action: "enrollment diagnostics",
      args: params.args,
      binary: params.binary,
      input: [
        `state_dir="$HOME/.openclaw/cloud-workers/${params.id}"`,
        'printf "node-runtime="',
        'if [ -L "$state_dir/runtime" ]; then readlink "$state_dir/runtime"; else printf absent; fi',
        'printf " node-pid="',
        'if [ -s "$state_dir/node.pid" ] && kill -0 "$(head -c 32 "$state_dir/node.pid")" 2>/dev/null; then printf alive; else printf dead-or-absent; fi',
        'printf " node.log tail: "',
        'if [ -r "$state_dir/node.log" ]; then tail -c 2000 "$state_dir/node.log"; else printf absent; fi',
      ].join("\n"),
      runCommand: params.runCommand,
      ...(params.signal ? { signal: params.signal } : {}),
      // The enrollment deadline has already elapsed; diagnostics need their own bounded budget.
      timeoutMs: NODE_ENROLLMENT_DIAGNOSTIC_TIMEOUT_MS,
    });
    if (result.termination !== "exit" || result.code !== 0) {
      throw crabboxCommandError("enrollment diagnostics", result);
    }
    detail = result.stdout.trim();
    if (!detail) {
      throw new Error("diagnostic command returned no output");
    }
  } catch (error) {
    label = "box evidence unavailable";
    detail = error instanceof Error ? error.message : "diagnostic command failed";
  }
  const prefix = `${label}: `;
  const safeDetail = redactToolPayloadText(detail).replace(/\s+/gu, " ").trim();
  return `${prefix}${truncateUtf8Prefix(safeDetail, MAX_NODE_ENROLLMENT_EVIDENCE_BYTES - prefix.length)}`;
}
