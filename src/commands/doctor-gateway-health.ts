import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import type { DoctorMemoryStatusPayload } from "../gateway/server-methods/doctor.js";
import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { formatHealthCheckFailure } from "./health-format.js";
import type { StatusSummary } from "./status.types.js";

export type GatewayMemoryProbe = {
  checked: boolean;
  ready: boolean;
  error?: string;
  /**
   * True when the probe was intentionally skipped by the gateway (probe: false
   * path). Distinct from checked: false caused by a network timeout or
   * unavailable gateway. Renderers should suppress warnings only for skipped
   * probes, not for transport failures.
   */
  skipped: boolean;
};

function isGatewayCallTimeout(message: string): boolean {
  return /^gateway timeout after \d+ms(?:\n|$)/.test(message);
}

export async function checkGatewayHealth(params: {
  runtime: RuntimeEnv;
  cfg: OpenClawConfig;
  timeoutMs?: number;
}): Promise<{ healthOk: boolean; status?: StatusSummary }> {
  const gatewayDetails = buildGatewayConnectionDetails({ config: params.cfg });
  const timeoutMs =
    typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 10_000;
  let healthOk = false;
  let status: StatusSummary | undefined;
  try {
    status = await callGateway<StatusSummary>({
      method: "status",
      params: { includeChannelSummary: false },
      timeoutMs,
      config: params.cfg,
    });
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

  return { healthOk, status };
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
      params: { probe: false },
      timeoutMs,
      config: params.cfg,
    });
    // Propagate the gateway's checked flag. When the gateway skips the embedding
    // probe (probe: false path), it returns checked: false to signal that no
    // readiness determination was made. Mapping that to checked: true here would
    // cause the renderer to treat a skipped probe as a checked-but-not-ready
    // failure and emit a false-positive warning for key-optional providers.
    // We also carry skipped: true so renderers can distinguish an intentional
    // non-deep skip from a transport timeout (which also returns checked: false).
    const gatewayChecked = payload.embedding.checked !== false;
    return {
      checked: gatewayChecked,
      ready: payload.embedding.ok,
      error: payload.embedding.error,
      skipped: !gatewayChecked,
    };
  } catch (err) {
    const message = formatErrorMessage(err);
    if (isGatewayCallTimeout(message)) {
      return {
        checked: false,
        ready: false,
        error: `gateway memory probe timed out: ${message}`,
        skipped: false,
      };
    }
    return {
      checked: true,
      ready: false,
      error: `gateway memory probe unavailable: ${message}`,
      skipped: false,
    };
  }
}
