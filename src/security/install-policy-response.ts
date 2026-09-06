import { createHash } from "node:crypto";
import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { z } from "zod";
import { formatErrorMessage } from "../infra/errors.js";

const MAX_REASON_CHARS = 1000;
const MAX_FINDINGS = 100;
const MAX_FINDING_TEXT_CHARS = 1000;
const TRUNCATION_MARKER = "...";

export type InstallPolicyFinding = {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  message: string;
  file?: string;
  line?: number;
  evidence?: string;
};

export type InstallPolicyResult =
  | { blocked?: undefined; warning?: undefined; findings?: InstallPolicyFinding[] }
  | {
      blocked?: undefined;
      warning: { reason: string; fingerprint: string };
      findings?: InstallPolicyFinding[];
    }
  | {
      blocked: {
        code: "security_scan_blocked" | "security_scan_failed";
        reason: string;
      };
      warning?: undefined;
      findings?: InstallPolicyFinding[];
    };

const installPolicyResponseEnvelopeSchema = z.object({
  protocolVersion: z.literal(1),
  decision: z.enum(["allow", "warn", "block"]),
  reason: z.unknown().optional(),
  findings: z.array(z.unknown()).optional().catch(undefined),
});

const installPolicyReasonSchema = z.string().trim().min(1);
const findingTextSchema = z.string().trim().min(1);
const optionalFindingTextSchema = findingTextSchema.optional().catch(undefined);

const installPolicyFindingSchema = z
  .object({
    ruleId: findingTextSchema,
    severity: z.enum(["info", "warn", "critical"]),
    message: findingTextSchema,
    file: optionalFindingTextSchema,
    line: z
      .number()
      .finite()
      .transform((value) => Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(value))))
      .optional()
      .catch(undefined),
    evidence: optionalFindingTextSchema,
  })
  .transform(({ evidence, file, line, ...finding }) => ({
    ...finding,
    ...(file ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(evidence ? { evidence } : {}),
  }));

function truncateText(value: string, maxChars: number): string {
  return truncateWithMarker(value, maxChars, {
    marker: TRUNCATION_MARKER,
    reserve: TRUNCATION_MARKER.length,
    trimEnd: false,
  });
}

export function createInstallPolicyFailure(message: string): InstallPolicyResult {
  return {
    blocked: {
      code: "security_scan_failed",
      reason: `install policy failed closed: ${truncateText(message, MAX_REASON_CHARS)}`,
    },
  };
}

function blockedByPolicy(reason: string, findings?: InstallPolicyFinding[]): InstallPolicyResult {
  return {
    blocked: {
      code: "security_scan_blocked",
      reason: `blocked by install policy: ${truncateText(reason, MAX_REASON_CHARS)}`,
    },
    ...(findings && findings.length > 0 ? { findings } : {}),
  };
}

function normalizeFinding(value: unknown): InstallPolicyFinding | null {
  const parsed = installPolicyFindingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function truncateFinding(finding: InstallPolicyFinding): InstallPolicyFinding {
  return {
    ruleId: truncateText(finding.ruleId, MAX_FINDING_TEXT_CHARS),
    severity: finding.severity,
    message: truncateText(finding.message, MAX_FINDING_TEXT_CHARS),
    ...(finding.file ? { file: truncateText(finding.file, MAX_FINDING_TEXT_CHARS) } : {}),
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    ...(finding.evidence
      ? { evidence: truncateText(finding.evidence, MAX_FINDING_TEXT_CHARS) }
      : {}),
  };
}

function fingerprintWarning(reason: string, findings: InstallPolicyFinding[]): string {
  return createHash("sha256").update(JSON.stringify({ reason, findings })).digest("hex");
}

function formatPolicyResponseEnvelopeError(error: z.ZodError): string {
  const invalidPath = error.issues[0]?.path[0];
  return invalidPath === undefined
    ? "policy response must be a JSON object"
    : invalidPath === "protocolVersion"
      ? "policy response protocolVersion must be 1"
      : 'policy response decision must be "allow", "warn", or "block"';
}

export function parseInstallPolicyResponse(stdout: string): InstallPolicyResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return createInstallPolicyFailure("policy command returned empty stdout");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (err) {
    return createInstallPolicyFailure(
      `policy command returned invalid JSON (${formatErrorMessage(err)})`,
    );
  }
  const response = installPolicyResponseEnvelopeSchema.safeParse(parsed);
  if (!response.success) {
    return createInstallPolicyFailure(formatPolicyResponseEnvelopeError(response.error));
  }
  const fullFindings = (response.data.findings ?? [])
    .map(normalizeFinding)
    .filter((finding): finding is InstallPolicyFinding => finding !== null);
  const normalizedFindings = fullFindings.slice(0, MAX_FINDINGS).map(truncateFinding);
  if (response.data.decision === "allow") {
    return normalizedFindings.length > 0 ? { findings: normalizedFindings } : {};
  }
  const reason = installPolicyReasonSchema.safeParse(response.data.reason);
  if (!reason.success) {
    return createInstallPolicyFailure(
      `policy response decision "${response.data.decision}" requires a non-empty reason`,
    );
  }
  if (response.data.decision === "warn") {
    if (fullFindings.length > MAX_FINDINGS) {
      return createInstallPolicyFailure(
        `policy warning returned more than ${String(MAX_FINDINGS)} valid findings; reduce the findings before retrying`,
      );
    }
    return {
      warning: {
        reason: truncateText(reason.data, MAX_REASON_CHARS),
        fingerprint: fingerprintWarning(reason.data, fullFindings),
      },
      ...(normalizedFindings.length > 0 ? { findings: normalizedFindings } : {}),
    };
  }
  return blockedByPolicy(reason.data, normalizedFindings);
}
