// Shared command runner for `openclaw status --json`.
// It keeps scan execution separate from JSON payload assembly so CLI variants can reuse the same output path.

import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveStatusJsonOutput } from "./status-json-runtime.ts";

type StatusJsonCommandOptions = {
  deep?: boolean;
  usage?: boolean;
  agent?: string;
  timeoutMs?: number;
  all?: boolean;
};

/** Prevents --agent from implying that the aggregate status report itself is agent-scoped. */
export function assertStatusUsageAgentScope(opts: StatusJsonCommandOptions): void {
  if (opts.agent !== undefined && opts.usage !== true) {
    throw new Error("--agent is only valid with --usage");
  }
}

/** Runs the fast status scan, resolves optional deep fields, and writes JSON through the runtime. */
export async function runStatusJsonCommand(params: {
  opts: StatusJsonCommandOptions;
  runtime: RuntimeEnv;
  includeSecurityAudit: boolean;
  includePluginCompatibility?: boolean;
  suppressHealthErrors?: boolean;
  scanStatusJsonFast: (
    opts: { timeoutMs?: number; all?: boolean },
    runtime: RuntimeEnv,
  ) => Promise<Parameters<typeof resolveStatusJsonOutput>[0]["scan"]>;
}) {
  assertStatusUsageAgentScope(params.opts);
  const scan = await params.scanStatusJsonFast(
    { timeoutMs: params.opts.timeoutMs, all: params.opts.all },
    params.runtime,
  );
  writeRuntimeJson(
    params.runtime,
    await resolveStatusJsonOutput({
      scan,
      opts: params.opts,
      includeSecurityAudit: params.includeSecurityAudit,
      includePluginCompatibility: params.includePluginCompatibility,
      suppressHealthErrors: params.suppressHealthErrors,
    }),
  );
}
