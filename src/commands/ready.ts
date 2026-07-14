import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { CanonicalReadinessResult, ReadinessCondition } from "../readiness/conditions.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

export type ReadyCommandOptions = { json?: boolean; timeoutMs?: number };

type ReadyCommandError = {
  ready: false;
  error: {
    reason: "GatewayReadinessUnavailable";
    message: string;
  };
};

function conditionMark(condition: ReadinessCondition): string {
  if (condition.status === "True") {
    return "PASS";
  }
  return condition.requirement === "required" ? "FAIL" : "WARN";
}

export function formatReadyResult(result: CanonicalReadinessResult): string {
  const required = result.conditions.filter((condition) => condition.requirement === "required");
  const requiredPassing = required.filter((condition) => condition.status === "True").length;
  const lines = [
    `Ready: ${result.ready ? "yes" : "no"}`,
    `Required: ${requiredPassing}/${required.length}`,
    `Advisories: ${result.advisories.length}`,
  ];

  if (result.conditions.length > 0) {
    lines.push(
      "",
      renderTable({
        width: getTerminalTableWidth(),
        border: "none",
        columns: [
          { key: "result", header: "RESULT", minWidth: 4 },
          { key: "requirement", header: "CLASS", minWidth: 8 },
          { key: "condition", header: "CONDITION", minWidth: 16 },
          { key: "reason", header: "REASON", minWidth: 16 },
          { key: "message", header: "DETAIL", flex: true, minWidth: 20 },
        ],
        rows: result.conditions.map((condition) => ({
          result: conditionMark(condition),
          requirement: condition.requirement,
          condition: condition.type,
          reason: condition.reason,
          message: condition.message,
        })),
      }),
    );
  }
  return lines.join("\n");
}

function emitError(runtime: RuntimeEnv, json: boolean, error: ReadyCommandError): void {
  if (json) {
    writeRuntimeJson(runtime, error);
  } else {
    runtime.error("Ready: no");
    runtime.error(`${error.error.reason}: ${error.error.message}`);
  }
  runtime.exit(1);
}

export async function readyCommand(
  opts: ReadyCommandOptions,
  runtime: RuntimeEnv,
  dependencies: {
    loadConfig?: () => Promise<OpenClawConfig>;
    callReady?: (params: {
      config: OpenClawConfig;
      timeoutMs?: number;
    }) => Promise<CanonicalReadinessResult>;
  } = {},
): Promise<void> {
  const loadConfig =
    dependencies.loadConfig ??
    (async () => (await import("../config/config.js")).readBestEffortConfig());
  const callReady =
    dependencies.callReady ??
    (async ({ config, timeoutMs }) =>
      await callGateway<CanonicalReadinessResult>({
        method: "ready",
        params: {},
        timeoutMs,
        config,
      }));

  let readiness: CanonicalReadinessResult;
  try {
    const config = await loadConfig();
    readiness = await callReady({ config, timeoutMs: opts.timeoutMs });
  } catch (error) {
    emitError(runtime, Boolean(opts.json), {
      ready: false,
      error: { reason: "GatewayReadinessUnavailable", message: formatErrorMessage(error) },
    });
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, readiness);
  } else {
    runtime.log(formatReadyResult(readiness));
  }
  if (!readiness.ready) {
    runtime.exit(1);
  }
}
