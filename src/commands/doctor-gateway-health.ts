/** Gateway health probes used by doctor before deeper daemon and memory diagnostics. */
import { note } from "../../packages/terminal-core/src/note.js";
import { probeGatewayStatus } from "../cli/daemon-cli/probe.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildGatewayConnectionDetails,
  buildGatewayProbeConnectionDetails,
  callGateway,
  isGatewayCredentialsRequiredError,
} from "../gateway/call.js";
import { isGatewaySecretRefUnavailableError } from "../gateway/credentials.js";
import type {
  DoctorMemoryEmbeddingRuntimePayload,
  DoctorMemoryStatusPayload,
} from "../gateway/server-methods/doctor.js";
import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { VERSION } from "../version.js";
import {
  GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
  GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE,
  gatewayProbeResultSawGateway,
} from "./gateway-health-auth-diagnostic.js";
import { formatGatewayClosedDiagnostic, formatHealthCheckFailure } from "./health-format.js";
import type { StatusSummary } from "./status.types.js";

type GatewayMemoryProbe = {
  checked: boolean;
  ready: boolean;
  error?: string;
  runtimeFacts?: DoctorMemoryEmbeddingRuntimePayload;
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

function isGatewayHealthAuthUnavailableError(error: unknown): boolean {
  return isGatewayCredentialsRequiredError(error) || isGatewaySecretRefUnavailableError(error);
}

function noteCliGatewayVersionSkew(status: StatusSummary | undefined): void {
  const gatewayVersion = status?.runtimeVersion?.trim();
  if (!gatewayVersion || gatewayVersion === VERSION) {
    return;
  }
  note(
    [
      `This command is OpenClaw ${VERSION}; the running Gateway is OpenClaw ${gatewayVersion}.`,
      "Check `openclaw --version`, `which openclaw`, and `openclaw gateway status --deep`.",
      "If this mismatch is unexpected, update PATH so `openclaw` points to the version you want, or reinstall the Gateway service from that same OpenClaw install.",
    ].join("\n"),
    "OpenClaw version mismatch",
  );
}

/**
 * Probes gateway status and reports user-facing connection/auth/channel warnings.
 *
 * A credentials-required gateway still counts as healthy but unauthenticated when the preauth
 * probe confirms the server is reachable.
 */
export async function checkGatewayHealth(params: {
  runtime: RuntimeEnv;
  cfg: OpenClawConfig;
  timeoutMs?: number;
}): Promise<{ healthOk: boolean; authenticated: boolean; status?: StatusSummary }> {
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
    noteCliGatewayVersionSkew(status);
    try {
      const statusLocal = await callGateway({
        method: "channels.status",
        params: { probe: true, timeoutMs: 5000 },
        timeoutMs: 6000,
      });
      const issues = collectChannelStatusIssues(statusLocal);
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
    return { healthOk, authenticated: true, status };
  } catch (err) {
    if (isGatewayHealthAuthUnavailableError(err)) {
      const probeDetails = await buildGatewayProbeConnectionDetails({ config: params.cfg });
      const probe = await probeGatewayStatus({
        url: probeDetails.url,
        timeoutMs,
        tlsFingerprint: probeDetails.tlsFingerprint,
        preauthHandshakeTimeoutMs: probeDetails.preauthHandshakeTimeoutMs,
        config: params.cfg,
        json: true,
      });
      if (gatewayProbeResultSawGateway(probe)) {
        note(
          GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
          GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE,
        );
        healthOk = true;
        return { healthOk, authenticated: false };
      }
    }
    const message = String(err);
    if (message.includes("gateway closed")) {
      const gatewayDetails = buildGatewayConnectionDetails({ config: params.cfg });
      const closedDiagnostic = formatGatewayClosedDiagnostic(err);
      if (closedDiagnostic) {
        note(closedDiagnostic, "Gateway");
      } else {
        note("Gateway not running.", "Gateway");
      }
      note(gatewayDetails.message, "Gateway connection");
    } else {
      params.runtime.error(formatHealthCheckFailure(err));
    }
  }

  return { healthOk, authenticated: false, status };
}

/** Probes gateway memory readiness without forcing deep embedding checks. */
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
      ...(payload.embeddingRuntime ? { runtimeFacts: payload.embeddingRuntime } : {}),
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
