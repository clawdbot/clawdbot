import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  redactSecretDegradationReason,
  SECRET_DEGRADATION_RETRY_HINT,
} from "../secrets/runtime-degraded-state.js";
import type { StatusSummary } from "../status/types.js";

const DOCTOR_SECRET_OWNER_ID_MAX_CHARS = 96;
const DOCTOR_SECRET_OWNER_PATH_MAX_CHARS = 120;
const DOCTOR_SECRET_OWNER_VISIBLE_PATHS = 3;

function safeDoctorSecretOwnerText(value: string, maxChars: number): string {
  const safe = sanitizeTerminalText(redactSensitiveUrlLikeString(value));
  return safe.length <= maxChars ? safe : `${truncateUtf16Safe(safe, maxChars - 1)}…`;
}

/** Projects Gateway-owned secret degradation into the shared bounded Doctor display shape. */
export function projectDoctorSecretRuntimeDegradations(
  status: Pick<StatusSummary, "degradedSecretOwners" | "secretEgressProxy">,
) {
  const findings = (status.degradedSecretOwners ?? []).map((owner) => {
    const ownerId = safeDoctorSecretOwnerText(owner.ownerId, DOCTOR_SECRET_OWNER_ID_MAX_CHARS);
    const target = `${owner.ownerKind}:${ownerId}`;
    const visiblePaths = owner.paths
      .slice(0, DOCTOR_SECRET_OWNER_VISIBLE_PATHS)
      .map((configPath) =>
        safeDoctorSecretOwnerText(configPath, DOCTOR_SECRET_OWNER_PATH_MAX_CHARS),
      );
    const omittedPaths = owner.paths.length - visiblePaths.length;
    const paths =
      visiblePaths.join(", ") + (omittedPaths > 0 ? ` (+${omittedPaths} paths omitted)` : "");
    return {
      message: `${owner.degradationState ?? "cold"} ${target} (${paths || "no affected paths reported"}): ${redactSecretDegradationReason(owner.reason)}`,
      path: visiblePaths[0] ?? "gateway",
      target,
      retryHint: SECRET_DEGRADATION_RETRY_HINT,
    };
  });
  if (status.secretEgressProxy?.state !== "degraded") {
    return findings;
  }
  return [
    ...findings,
    {
      message:
        "Secret egress proxy: " +
        safeDoctorSecretOwnerText(
          status.secretEgressProxy.message ??
            "TLS certificate preparation unavailable. Check Gateway logs.",
          512,
        ),
      path: "secrets.egressProxy.enabled",
      target: "capability:secret-egress-proxy",
      retryHint: "Correct the reported certificate or clock problem before retrying the request.",
    },
  ];
}
