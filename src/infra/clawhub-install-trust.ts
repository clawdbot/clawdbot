// Shared ClawHub exact-release trust gate for plugin and skill installs.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stripAnsi, visibleWidth } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { resolveClawHubBaseUrl } from "./clawhub-client.js";
import {
  fetchClawHubPackageSecurity,
  type ClawHubPackageSecurityResponse,
  type ClawHubPackageSecurityTrust,
} from "./clawhub-packages.js";
import { fetchExactClawHubSkillSecurityVerdicts } from "./clawhub-skill-security.js";
import type { ClawHubSkillSecurityVerdictItem } from "./clawhub-skills.js";
import { formatErrorMessage } from "./errors.js";

export const CLAWHUB_TRUST_ERROR_CODE = {
  CLAWHUB_SECURITY_UNAVAILABLE: "clawhub_security_unavailable",
  CLAWHUB_DOWNLOAD_BLOCKED: "clawhub_download_blocked",
} as const;

export type ClawHubTrustErrorCode =
  (typeof CLAWHUB_TRUST_ERROR_CODE)[keyof typeof CLAWHUB_TRUST_ERROR_CODE];

type ClawHubTrustInstallRecordFields = {
  clawhubTrustDisposition: "clean" | "review-recommended" | "review-required" | "blocked";
  clawhubTrustScanStatus?: string;
  clawhubTrustModerationState?: string;
  clawhubTrustReasons?: string[];
  clawhubTrustPending?: true;
  clawhubTrustStale?: true;
  clawhubTrustCheckedAt: string;
};

type ClawHubTrustAcceptedResult = {
  ok: true;
  trustInstallRecordFields: ClawHubTrustInstallRecordFields;
  warning?: string;
};

type ClawHubTrustFailure = {
  ok: false;
  error: string;
  code?: ClawHubTrustErrorCode;
  warning?: string;
  version?: string;
};

type ClawHubInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  terminalLinks?: boolean;
};

type ClawHubTrustSubject =
  | { kind: "plugin"; packageName: string }
  | { kind: "skill"; packageName: string; workspaceDir: string; ownerHandle?: string };

type ClawHubSecurityLinks = {
  subject: string;
  security: string;
};
type ClawHubFetchedSubjectSecurity = {
  security: ClawHubPackageSecurityResponse;
  links?: {
    subject?: string;
    security?: string;
  };
};

const CLAWHUB_RISK_MODERATION_STATES = new Set(["blocked", "quarantined", "revoked"]);
const CLAWHUB_BLOCKING_MODERATION_STATES = new Set(["blocked", "quarantined", "revoked"]);
const CLAWHUB_SAFE_MODERATION_STATES = new Set(["", "approved"]);
const CLAWHUB_NON_RISK_SCAN_STATUSES = new Set(["pending", "scan_pending", "stale", "stale_scan"]);
const CLAWHUB_NON_RISK_REASONS = new Set([
  "pending",
  "pending_scan",
  "scan:pending",
  "scan_pending",
  "stale",
  "scan:stale",
  "stale_scan",
]);

function normalizeClawHubTrustToken(value: string | null | undefined): string {
  return normalizeOptionalString(value)?.toLowerCase() ?? "";
}

function formatClawHubTrustStatus(label: string, token: string): string {
  return token ? `${label} is ${token}` : `${label} is missing`;
}

function formatClawHubReasonCode(reason: string): string {
  const normalized = normalizeClawHubTrustToken(reason);
  switch (normalized) {
    case "scan:malicious":
      return "malicious behavior detected";
    case "static:malicious":
      return "malicious behavior detected";
    case "payload_strings":
      return "suspicious payload strings";
    case "security.status_not_clean":
      return "security status is not clean";
    case "skill.not_found":
      return "skill was not found";
    case "version.not_found":
      return "skill version was not found";
    case "scan:pending":
    case "pending_scan":
    case "scan_pending":
      return "scan pending";
    case "scan:stale":
    case "stale_scan":
      return "scan data stale";
    default:
      return reason;
  }
}

type ClawHubTrustAssessment = {
  disposition: ClawHubTrustInstallRecordFields["clawhubTrustDisposition"];
  riskReasons: string[];
  notices: string[];
};

function isPendingOrStaleTrustWarning(trust: ClawHubPackageSecurityTrust): boolean {
  return trust.pending || trust.stale;
}

function isNonRiskScanStatus(trust: ClawHubPackageSecurityTrust, scanStatus: string): boolean {
  return isPendingOrStaleTrustWarning(trust) && CLAWHUB_NON_RISK_SCAN_STATUSES.has(scanStatus);
}

function isNonRiskReason(trust: ClawHubPackageSecurityTrust, reason: string): boolean {
  return isPendingOrStaleTrustWarning(trust) && CLAWHUB_NON_RISK_REASONS.has(reason);
}

function resolveClawHubRiskReasons(trust: ClawHubPackageSecurityTrust): string[] {
  const reasons: string[] = [];
  if (trust.blockedFromDownload) {
    reasons.push("Download disabled by ClawHub for this release");
  }
  const scanStatus = normalizeClawHubTrustToken(trust.scanStatus);
  if (scanStatus !== "clean" && !isNonRiskScanStatus(trust, scanStatus)) {
    reasons.push(formatClawHubTrustStatus("security scan status", scanStatus));
  }
  const moderationState = normalizeClawHubTrustToken(trust.moderationState);
  if (
    CLAWHUB_RISK_MODERATION_STATES.has(moderationState) ||
    !CLAWHUB_SAFE_MODERATION_STATES.has(moderationState)
  ) {
    reasons.push(formatClawHubTrustStatus("moderation state", moderationState));
  }
  for (const reason of trust.reasons) {
    const normalized = normalizeClawHubTrustToken(reason);
    if (normalized && !isNonRiskReason(trust, normalized)) {
      reasons.push(formatClawHubReasonCode(reason));
    }
  }
  return reasons;
}

function resolveClawHubTrustStatusNotices(trust: ClawHubPackageSecurityTrust): string[] {
  const notices: string[] = [];
  if (trust.pending) {
    notices.push("security scan is pending");
  }
  if (trust.stale) {
    notices.push("scan data is stale");
  }
  for (const reason of trust.reasons) {
    const normalized = normalizeClawHubTrustToken(reason);
    if (normalized && isNonRiskReason(trust, normalized)) {
      notices.push(formatClawHubReasonCode(reason));
    }
  }
  return notices;
}

function isBlockingClawHubTrust(trust: ClawHubPackageSecurityTrust): boolean {
  if (trust.blockedFromDownload) {
    return true;
  }
  if (normalizeClawHubTrustToken(trust.scanStatus) === "malicious") {
    return true;
  }
  if (CLAWHUB_BLOCKING_MODERATION_STATES.has(normalizeClawHubTrustToken(trust.moderationState))) {
    return true;
  }
  return trust.reasons.some((reason) => {
    const normalized = normalizeClawHubTrustToken(reason);
    return normalized === "scan:malicious" || normalized === "static:malicious";
  });
}

function assessClawHubTrust(trust: ClawHubPackageSecurityTrust): ClawHubTrustAssessment {
  const riskReasons = resolveClawHubRiskReasons(trust);
  const notices = resolveClawHubTrustStatusNotices(trust);
  if (riskReasons.length === 0 && notices.length === 0) {
    return { disposition: "clean", riskReasons, notices };
  }
  if (isBlockingClawHubTrust(trust)) {
    return { disposition: "blocked", riskReasons, notices };
  }
  if (riskReasons.length > 0) {
    return { disposition: "review-required", riskReasons, notices };
  }
  return { disposition: "review-recommended", riskReasons, notices };
}

function buildClawHubTrustInstallRecordFields(params: {
  trust: ClawHubPackageSecurityTrust;
  assessment: ClawHubTrustAssessment;
  checkedAt: string;
}): ClawHubTrustInstallRecordFields {
  const scanStatus = normalizeClawHubTrustToken(params.trust.scanStatus);
  const moderationState = normalizeClawHubTrustToken(params.trust.moderationState);
  const reasons = params.trust.reasons
    .map((reason) => normalizeOptionalString(reason))
    .filter((reason): reason is string => Boolean(reason));
  return {
    clawhubTrustDisposition: params.assessment.disposition,
    ...(scanStatus ? { clawhubTrustScanStatus: scanStatus } : {}),
    ...(moderationState ? { clawhubTrustModerationState: moderationState } : {}),
    ...(reasons.length > 0 ? { clawhubTrustReasons: reasons } : {}),
    ...(params.trust.pending ? { clawhubTrustPending: true } : {}),
    ...(params.trust.stale ? { clawhubTrustStale: true } : {}),
    clawhubTrustCheckedAt: params.checkedAt,
  };
}

function encodeClawHubPackagePath(packageName: string): string {
  return packageName
    .split("/")
    .map((part) => encodeURIComponent(part).replaceAll("%40", "@"))
    .join("/");
}

function resolveClawHubSubjectUrl(params: {
  baseUrl?: string;
  subject: ClawHubTrustSubject;
}): string {
  if (params.subject.kind === "skill" && params.subject.ownerHandle) {
    return `${resolveClawHubBaseUrl(params.baseUrl)}/${encodeURIComponent(params.subject.ownerHandle)}/skills/${encodeURIComponent(params.subject.packageName)}`;
  }
  const pathRoot = params.subject.kind === "skill" ? "skills" : "plugins";
  return `${resolveClawHubBaseUrl(params.baseUrl)}/${pathRoot}/${encodeClawHubPackagePath(params.subject.packageName)}`;
}

function resolveClawHubSecurityLinks(params: {
  baseUrl?: string;
  subject: ClawHubTrustSubject;
  version: string;
  links?: {
    subject?: string;
    security?: string;
  };
}): ClawHubSecurityLinks {
  const subjectUrl = resolveClawHubSubjectUrl(params);
  if (params.subject.kind === "skill") {
    const resolvedSubjectUrl = normalizeOptionalString(params.links?.subject) ?? subjectUrl;
    return {
      subject: resolvedSubjectUrl,
      security:
        normalizeOptionalString(params.links?.security) ??
        `${resolvedSubjectUrl}/security-audit?version=${encodeURIComponent(params.version)}`,
    };
  }
  return {
    subject: subjectUrl,
    security:
      normalizeOptionalString(params.links?.security) ??
      `${subjectUrl}/security-audit?version=${encodeURIComponent(params.version)}`,
  };
}

function wrapClawHubAuditLine(value: string, width: number): string[] {
  if (visibleWidth(value) <= width) {
    return [value];
  }
  const words = value.split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && visibleWidth(next) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  return line ? [...lines, line] : lines;
}

function renderClawHubAuditBox(lines: string[]): string {
  const columns = Math.max(72, Math.min(process.stdout.columns ?? 88, 104));
  const innerWidth = Math.max(54, Math.min(columns - 4, 88));
  const title = "─ ClawHub Security Audit ";
  const borderWidth = innerWidth + 2;
  const top = `╭${title}${"─".repeat(Math.max(0, borderWidth - visibleWidth(title)))}╮`;
  const body = lines.flatMap((line) => {
    if (!line) {
      return [`│ ${" ".repeat(innerWidth)} │`];
    }
    return wrapClawHubAuditLine(line, innerWidth).map(
      (wrapped) => `│ ${wrapped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(wrapped)))} │`,
    );
  });
  return [top, ...body, `╰${"─".repeat(borderWidth)}╯`].join("\n");
}

function formatClawHubSecurityAudit(params: {
  baseUrl?: string;
  subject: ClawHubTrustSubject;
  version: string;
  overview: string;
  assessment: ClawHubTrustAssessment;
  links?: {
    subject?: string;
    security?: string;
  };
}): string {
  const links = resolveClawHubSecurityLinks({
    baseUrl: params.baseUrl,
    subject: params.subject,
    version: params.version,
    links: params.links,
  });
  const releaseLabel = formatClawHubSubjectReleaseLabel(params.subject, params.version);
  const outcome =
    params.assessment.disposition === "blocked"
      ? theme.error("Blocked")
      : params.assessment.disposition === "clean"
        ? theme.success("Safe")
        : theme.warn("Review");
  return renderClawHubAuditBox([
    releaseLabel,
    "",
    `Outcome: ${outcome}`,
    "",
    "Overview:",
    ...params.overview.split("\n").map((line) => sanitizeTerminalText(line)),
    "",
    `Details: ${sanitizeTerminalText(links.security)}`,
  ]);
}

function formatClawHubReleaseLabel(packageName: string, version: string): string {
  return `${sanitizeTerminalText(packageName)}@${sanitizeTerminalText(version)}`;
}

function formatClawHubSubjectPackageName(subject: ClawHubTrustSubject): string {
  return subject.kind === "skill" && subject.ownerHandle
    ? `@${subject.ownerHandle}/${subject.packageName}`
    : subject.packageName;
}

function formatClawHubSubjectReleaseLabel(subject: ClawHubTrustSubject, version: string): string {
  return formatClawHubReleaseLabel(formatClawHubSubjectPackageName(subject), version);
}

function validateClawHubSecurityIdentity(params: {
  security: ClawHubPackageSecurityResponse;
  packageName: string;
  packageLabel?: string;
  version: string;
}): ClawHubTrustFailure | null {
  const packageLabel = params.packageLabel ?? params.packageName;
  const responsePackageName = normalizeOptionalString(params.security.package?.name);
  if (responsePackageName !== params.packageName) {
    return {
      ok: false,
      error: `ClawHub release trust check for "${formatClawHubReleaseLabel(packageLabel, params.version)}" returned package "${sanitizeTerminalText(responsePackageName ?? "unknown")}".`,
      code: CLAWHUB_TRUST_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE,
      version: params.version,
    };
  }
  const responseVersion = normalizeOptionalString(params.security.release?.version);
  if (responseVersion !== params.version) {
    return {
      ok: false,
      error: `ClawHub release trust check for "${formatClawHubReleaseLabel(packageLabel, params.version)}" returned version "${sanitizeTerminalText(responseVersion ?? "unknown")}".`,
      code: CLAWHUB_TRUST_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE,
      version: params.version,
    };
  }
  return null;
}

function readSkillVerdictSecurityStatus(item: ClawHubSkillSecurityVerdictItem): string | undefined {
  if (!item.security || typeof item.security !== "object") {
    return undefined;
  }
  const security = item.security as { status?: unknown; rawStatus?: unknown };
  if (typeof security.status === "string") {
    return security.status;
  }
  return typeof security.rawStatus === "string" ? security.rawStatus : undefined;
}

function readSkillVerdictSecurityPassed(
  item: ClawHubSkillSecurityVerdictItem,
): boolean | undefined {
  if (!item.security || typeof item.security !== "object") {
    return undefined;
  }
  const passed = (item.security as { passed?: unknown }).passed;
  return typeof passed === "boolean" ? passed : undefined;
}

function hasUsablePassingSkillVerdictSecurity(item: ClawHubSkillSecurityVerdictItem): boolean {
  return (
    Boolean(readSkillVerdictSecurityStatus(item)) && readSkillVerdictSecurityPassed(item) === true
  );
}

function hasSkillVerdictSecurityError(item: ClawHubSkillSecurityVerdictItem): boolean {
  return Boolean(item.error?.code || item.error?.message || item.version === null);
}

function isSkillVerdictPendingReason(reason: string): boolean {
  const normalized = normalizeClawHubTrustToken(reason);
  return normalized === "pending" || normalized === "pending_scan" || normalized === "scan_pending";
}

function isSkillVerdictStaleReason(reason: string): boolean {
  const normalized = normalizeClawHubTrustToken(reason);
  return normalized === "stale" || normalized === "scan:stale" || normalized === "stale_scan";
}

function isSkillVerdictBlockingReason(reason: string): boolean {
  const normalized = normalizeClawHubTrustToken(reason);
  return (
    normalized.includes("malicious") ||
    normalized.includes("malware") ||
    normalized.endsWith("_blocked") ||
    normalized.endsWith(".blocked") ||
    normalized === "blocked"
  );
}

function mapSkillSecurityVerdictToPackageSecurity(params: {
  item: ClawHubSkillSecurityVerdictItem;
  packageName: string;
  ownerHandle?: string;
  version: string;
}): ClawHubPackageSecurityResponse {
  const responseSlug = normalizeOptionalString(params.item.slug ?? params.item.requestedSlug);
  if (responseSlug !== params.packageName) {
    throw new Error(
      `ClawHub skill trust check for "${formatClawHubReleaseLabel(params.packageName, params.version)}" returned skill "${sanitizeTerminalText(responseSlug ?? "unknown")}".`,
    );
  }
  const responsePublisher = normalizeOptionalString(params.item.publisherHandle);
  if (params.ownerHandle && responsePublisher !== params.ownerHandle) {
    throw new Error(
      `ClawHub skill trust check for "${formatClawHubReleaseLabel(params.packageName, params.version)}" returned publisher "${sanitizeTerminalText(responsePublisher ?? "unknown")}", expected "${sanitizeTerminalText(params.ownerHandle)}".`,
    );
  }
  const responseVersion = normalizeOptionalString(params.item.version);
  if (responseVersion !== params.version) {
    const reason = params.item.error?.message
      ? `: ${sanitizeTerminalText(params.item.error.message)}`
      : "";
    throw new Error(
      `ClawHub skill trust check for "${formatClawHubReleaseLabel(params.packageName, params.version)}" returned version "${sanitizeTerminalText(responseVersion ?? "unknown")}"${reason}.`,
    );
  }
  if (hasSkillVerdictSecurityError(params.item)) {
    const reason = params.item.error?.message
      ? `: ${sanitizeTerminalText(params.item.error.message)}`
      : "";
    throw new Error(
      `ClawHub skill trust check for "${formatClawHubReleaseLabel(params.packageName, params.version)}" did not return a usable security verdict${reason}.`,
    );
  }
  const decision = normalizeClawHubTrustToken(params.item.decision);
  if (params.item.ok && decision === "pass" && !hasUsablePassingSkillVerdictSecurity(params.item)) {
    throw new Error(
      `ClawHub skill trust check for "${formatClawHubReleaseLabel(params.packageName, params.version)}" did not return a usable security verdict.`,
    );
  }

  const securityStatus = normalizeClawHubTrustToken(readSkillVerdictSecurityStatus(params.item));
  const securityPassed = readSkillVerdictSecurityPassed(params.item);
  const reasons = params.item.reasons
    .map((reason) => normalizeOptionalString(reason))
    .filter((reason): reason is string => Boolean(reason));
  const securityPassedAllowsInstall = securityPassed ?? true;
  const verdictPassed = params.item.ok && decision === "pass" && securityPassedAllowsInstall;
  const scanStatus = verdictPassed
    ? securityStatus || "clean"
    : securityStatus && securityStatus !== "clean"
      ? securityStatus
      : "suspicious";
  if (!verdictPassed && reasons.length === 0) {
    reasons.push(decision ? `decision:${decision}` : "decision:fail");
  }
  const hasBlockingReason = reasons.some(isSkillVerdictBlockingReason);
  const displayName = normalizeOptionalString(params.item.displayName);
  const overview = params.item.overview;
  if (typeof overview !== "string" || !overview.trim()) {
    throw new Error(
      `ClawHub skill trust check for "${formatClawHubReleaseLabel(params.packageName, params.version)}" did not return an audit overview.`,
    );
  }
  const securityAuditUrl = normalizeOptionalString(params.item.securityAuditUrl);
  if (!securityAuditUrl) {
    throw new Error(
      `ClawHub skill trust check for "${formatClawHubReleaseLabel(params.packageName, params.version)}" did not return a security audit URL.`,
    );
  }
  return {
    package: {
      name: params.packageName,
      family: "skill",
      ...(displayName ? { displayName } : {}),
    },
    release: {
      version: params.version,
    },
    overview,
    securityAuditUrl,
    trust: {
      scanStatus,
      moderationState: null,
      blockedFromDownload:
        decision === "blocked" || securityStatus === "malicious" || hasBlockingReason,
      reasons,
      pending: securityStatus === "pending" || reasons.some(isSkillVerdictPendingReason),
      stale: securityStatus === "stale" || reasons.some(isSkillVerdictStaleReason),
    },
  };
}

function resolveSkillSecurityLinks(
  item: ClawHubSkillSecurityVerdictItem,
): ClawHubFetchedSubjectSecurity["links"] {
  const subject = normalizeOptionalString(item.skillUrl);
  const security = normalizeOptionalString(item.securityAuditUrl);
  if (!subject && !security) {
    return undefined;
  }
  return {
    ...(subject ? { subject } : {}),
    ...(security ? { security } : {}),
  };
}

async function fetchClawHubSubjectSecurity(params: {
  subject: ClawHubTrustSubject;
  version: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
}): Promise<ClawHubFetchedSubjectSecurity> {
  if (params.subject.kind === "plugin") {
    const security = await fetchClawHubPackageSecurity({
      name: params.subject.packageName,
      version: params.version,
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
    });
    return {
      security,
      links: { security: security.securityAuditUrl },
    };
  }
  const [item] = await fetchExactClawHubSkillSecurityVerdicts({
    items: [
      {
        slug: params.subject.packageName,
        ...(params.subject.ownerHandle ? { ownerHandle: params.subject.ownerHandle } : {}),
        version: params.version,
      },
    ],
    baseUrl: params.baseUrl,
    token: params.token,
    timeoutMs: params.timeoutMs,
  });
  if (!item) {
    throw new Error(
      `ClawHub skill trust check for "${formatClawHubReleaseLabel(params.subject.packageName, params.version)}" returned no verdict.`,
    );
  }
  return {
    security: mapSkillSecurityVerdictToPackageSecurity({
      item,
      packageName: params.subject.packageName,
      ...(params.subject.ownerHandle ? { ownerHandle: params.subject.ownerHandle } : {}),
      version: params.version,
    }),
    links: resolveSkillSecurityLinks(item),
  };
}

export async function checkClawHubPackageTrust(params: {
  subject: ClawHubTrustSubject;
  version: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  logger?: ClawHubInstallLogger;
  mode?: "install" | "update";
  confirmInstall?: () => boolean | Promise<boolean>;
}): Promise<ClawHubTrustFailure | ClawHubTrustAcceptedResult> {
  let trust: ClawHubPackageSecurityTrust;
  let overview: string;
  let warningLinks: ClawHubFetchedSubjectSecurity["links"];
  const packageLabel = formatClawHubSubjectPackageName(params.subject);
  const releaseLabel = formatClawHubSubjectReleaseLabel(params.subject, params.version);
  try {
    const fetchedSecurity = await fetchClawHubSubjectSecurity({
      subject: params.subject,
      version: params.version,
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
    });
    const identityFailure = validateClawHubSecurityIdentity({
      security: fetchedSecurity.security,
      packageName: params.subject.packageName,
      packageLabel,
      version: params.version,
    });
    if (identityFailure) {
      return identityFailure;
    }
    trust = fetchedSecurity.security.trust;
    overview = fetchedSecurity.security.overview;
    warningLinks = fetchedSecurity.links;
  } catch (error) {
    return {
      ok: false,
      error: `ClawHub release trust check failed for "${releaseLabel}": ${sanitizeTerminalText(formatErrorMessage(error))}`,
      code: CLAWHUB_TRUST_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE,
      version: params.version,
    };
  }

  const assessment = assessClawHubTrust(trust);
  const checkedAt = new Date().toISOString();
  const acceptTrust = (warning?: string): ClawHubTrustAcceptedResult => ({
    ok: true,
    trustInstallRecordFields: buildClawHubTrustInstallRecordFields({
      trust,
      assessment,
      checkedAt,
    }),
    ...(warning ? { warning } : {}),
  });

  const terminalAudit = formatClawHubSecurityAudit({
    baseUrl: params.baseUrl,
    subject: params.subject,
    version: params.version,
    overview,
    assessment,
    links: warningLinks,
  });
  const audit = stripAnsi(
    formatClawHubSecurityAudit({
      baseUrl: params.baseUrl,
      subject: params.subject,
      version: params.version,
      overview,
      assessment,
      links: warningLinks,
    }),
  );
  if (assessment.disposition === "clean") {
    params.logger?.info?.(terminalAudit);
  } else {
    params.logger?.warn?.(terminalAudit);
  }
  if (assessment.disposition === "blocked") {
    const blockedVerb = params.mode === "update" ? "update" : "install";
    return {
      ok: false,
      error: `ClawHub blocked this release; ${blockedVerb} was not started.`,
      code: CLAWHUB_TRUST_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED,
      warning: audit,
      version: params.version,
    };
  }
  if (params.mode !== "update" && params.confirmInstall && !(await params.confirmInstall())) {
    return {
      ok: false,
      error: "Install cancelled.",
      warning: audit,
      version: params.version,
    };
  }
  return acceptTrust(assessment.disposition === "clean" ? undefined : audit);
}
