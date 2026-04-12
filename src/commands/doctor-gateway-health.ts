import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import type { DoctorMemoryStatusPayload } from "../gateway/server-methods/doctor.js";
import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { formatHealthCheckFailure } from "./health-format.js";
import { healthCommand } from "./health.js";

export type GatewayMemoryProbe = {
  checked: boolean;
  ready: boolean;
  error?: string;
};

export async function checkGatewayHealth(params: {
  runtime: RuntimeEnv;
  cfg: OpenClawConfig;
  timeoutMs?: number;
}) {
  const gatewayDetails = buildGatewayConnectionDetails({ config: params.cfg });
  const timeoutMs =
    typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 10_000;
  let healthOk = false;
  try {
    await healthCommand({ json: false, timeoutMs, config: params.cfg }, params.runtime);
    healthOk = true;
  } catch (err) {
    const message = String(err);
    if (message.includes("gateway closed")) {
      note("Gateway not running.", "Gateway");
      note(gatewayDetails.message, "Gateway connection");
    } else {
      params.runtime.error(formatHealthCheckFailure(err));
    }
  }

  if (healthOk) {
    try {
      const status = await callGateway({
        method: "channels.status",
        params: { probe: true, timeoutMs: 5000 },
        timeoutMs: 6000,
      });
      const issues = collectChannelStatusIssues(status);
      if (issues.length > 0) {
        note(
          issues
            .map(
              (issue) =>
                `- ${issue.channel} ${issue.accountId}: ${issue.message}${
                  issue.fix ? ` (${issue.fix})` : ""
                }`,
            )
            .join("\n"),
          "Channel warnings",
        );
      }
    } catch {
      // ignore: doctor already reported gateway health
    }
  }

  return { healthOk };
}

export async function probeGatewayMemoryStatus(params: {
  cfg: OpenClawConfig;
  timeoutMs?: number;
}): Promise<GatewayMemoryProbe> {
  const timeoutMs =
    typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 8_000;
  try {
    const payload = await callGateway<DoctorMemoryStatusPayload>({
      method: "doctor.memory.status",
      timeoutMs,
      config: params.cfg,
    });
    return {
      checked: true,
      ready: payload.embedding.ok,
      error: payload.embedding.error,
    };
  } catch (err) {
    const message = formatErrorMessage(err);
    return {
      checked: true,
      ready: false,
      error: `gateway memory probe unavailable: ${message}`,
    };
  }
}
