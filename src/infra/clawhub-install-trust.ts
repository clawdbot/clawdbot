// Shared ClawHub exact-release trust gate for plugin and skill installs.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stripAnsi, visibleWidth } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatTerminalLink } from "../../packages/terminal-core/src/terminal-link.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  fetchClawHubPackageSecurity,
  fetchClawHubSkillVerification,
  fetchClawHubSkillSecurityVerdicts,
  resolveClawHubBaseUrl,
  type ClawHubPackageSecurityResponse,
  type ClawHubPackageSecurityTrust,
  type ClawHubSkillSecurityVerdictItem,
  type ClawHubSkillVerificationResponse,
} from "./clawhub.js";
import { formatErrorMessage } from "./errors.js";

export const CLAWHUB_TRUST_ERROR_CODE = {
  CLAWHUB_SECURITY_UNAVAILABLE: "clawhub_security_unavailable",
  CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED: "clawhub_risk_acknowledgement_required",
  CLAWHUB_DOWNLOAD_BLOCKED: "clawhub_download_blocked",
} as const;

export type ClawHubTrustErrorCode =
  (typeof CLAWHUB_TRUST_ERROR_CODE)[keyof typeof CLAWHUB_TRUST_ERROR_CODE];

export type ClawHubRiskAcknowledgementRequest = {
  packageName: string;
  version: string;
  trust: ClawHubPackageSecurityTrust;
  acknowledgementKind: "confirm" | "type-package";
  warning: string;
};

type ClawHubTrustInstallRecordFields = {
  clawhubTrustDisposition: "clean" | "review-recommended" | "review-required" | "blocked";
  clawhubTrustScanStatus?: string;
  clawhubTrustModerationState?: string;
  clawhubTrustReasons?: string[];
  clawhubTrustPending?: true;
  clawhubTrustStale?: true;
  clawhubTrustCheckedAt: string;
  clawhubTrustAcknowledgedAt?: string;
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
  warn?: (message: string) => void;
  terminalLinks?: boolean;
};

type ClawHubTrustSubject = {
  kind: "plugin" | "skill";
  packageName: string;
  ownerHandle?: string;
};

type ClawHubSkillSecurityLinks = {
  subject: string;
  security: string;
};

type ClawHubPluginSecurityLinks = {
  subject: string;
  clawscan: string;
};

type ClawHubSecurityLinks = ClawHubSkillSecurityLinks | ClawHubPluginSecurityLinks;
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
const CLAWHUB_NON_SECURITY_SKILL_VERIFY_REASONS = new Set(["card.missing", "card_missing"]);
const CLAWHUB_EVIDENCE_LABEL_WIDTH = 15;
const CLAWHUB_RAW_LINK_LABEL_WIDTH = 16;

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

function hasMaliciousClawHubTrustSignal(trust: ClawHubPackageSecurityTrust): boolean {
  if (normalizeClawHubTrustToken(trust.scanStatus) === "malicious") {
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
  acknowledgedAt?: string;
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
    ...(params.acknowledgedAt ? { clawhubTrustAcknowledgedAt: params.acknowledgedAt } : {}),
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
    clawscan: `${subjectUrl}/security/clawscan`,
  };
}

function padRight(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function wrapWords(text: string, width: number): string[] {
  if (visibleWidth(text) <= width) {
    return [text];
  }
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (visibleWidth(next) > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

function resolveClawHubTrustAccent(
  disposition: ClawHubTrustAssessment["disposition"],
): (value: string) => string {
  switch (disposition) {
    case "blocked":
      return theme.error;
    case "review-required":
      return theme.warn;
    case "review-recommended":
      return theme.info;
    case "clean":
      return theme.success;
  }
  return theme.info;
}

function formatClawHubEvidenceLine(params: {
  label: string;
  value: string;
  accent: (value: string) => string;
}): string {
  const label = sanitizeTerminalText(params.label).replace(/:$/u, "");
  return `${theme.muted(`• ${padRight(label, CLAWHUB_EVIDENCE_LABEL_WIDTH)}`)} ${params.accent(params.value)}`;
}

function renderClawHubTrustBox(
  title: string,
  lines: string[],
  disposition: ClawHubTrustAssessment["disposition"],
): string {
  const accent = resolveClawHubTrustAccent(disposition);
  const columns = Math.max(72, Math.min(process.stdout.columns ?? 88, 104));
  const innerWidth = Math.max(54, Math.min(columns - 4, 78));
  const totalWidth = innerWidth + 4;
  const borderWidth = totalWidth - 2;
  const titleSegment = `─ ${title} `;
  const titleFillWidth = Math.max(0, borderWidth - visibleWidth(titleSegment));
  const top = accent(`╭${titleSegment}${"─".repeat(titleFillWidth)}╮`);
  const bottom = accent(`╰${"─".repeat(borderWidth)}╯`);
  const body = lines.flatMap((line) => {
    if (line === "") {
      return [`${accent("│")} ${" ".repeat(innerWidth)} ${accent("│")}`];
    }
    return wrapWords(line, innerWidth).map(
      (wrapped) => `${accent("│")} ${padRight(wrapped, innerWidth)} ${accent("│")}`,
    );
  });
  return [top, ...body, bottom].join("\n");
}

function formatLinkedClawHubValue(params: {
  label: string;
  url: string;
  terminalLinks?: boolean;
}): string {
  const label = sanitizeTerminalText(params.label);
  return formatTerminalLink(label, sanitizeTerminalText(params.url), {
    fallback: label,
    ...(params.terminalLinks !== undefined ? { force: params.terminalLinks } : {}),
  });
}

function formatClawHubTrustEvidenceLines(params: {
  trust: ClawHubPackageSecurityTrust;
  assessment: ClawHubTrustAssessment;
  links: ClawHubSecurityLinks;
  terminalLinks?: boolean;
}): string[] {
  const lines: string[] = [];
  const accent = resolveClawHubTrustAccent(params.assessment.disposition);
  const securityLink = "clawscan" in params.links ? params.links.clawscan : params.links.security;
  const addLine = (label: string, value: string): void => {
    lines.push(formatClawHubEvidenceLine({ label, value, accent }));
  };
  const linked = (label: string, url: string): string =>
    formatLinkedClawHubValue({ label, url, terminalLinks: params.terminalLinks });
  const scanStatus = normalizeClawHubTrustToken(params.trust.scanStatus);
  if (scanStatus) {
    addLine("Security scan:", linked(scanStatus, securityLink));
  }
  const moderationState = normalizeClawHubTrustToken(params.trust.moderationState);
  if (moderationState && !CLAWHUB_SAFE_MODERATION_STATES.has(moderationState)) {
    addLine("Moderation:", sanitizeTerminalText(moderationState));
  }
  for (const reason of params.trust.reasons) {
    const normalized = normalizeClawHubTrustToken(reason);
    if (!normalized) {
      continue;
    }
    if (
      params.assessment.disposition === "review-recommended" &&
      isNonRiskReason(params.trust, normalized)
    ) {
      continue;
    }
    switch (normalized) {
      case "scan:malicious":
        addLine("Scanner:", linked("malicious behavior detected", securityLink));
        break;
      case "static:malicious":
        addLine("Scanner:", linked("malicious behavior detected", securityLink));
        break;
      case "payload_strings":
        addLine("Finding:", linked("suspicious payload strings", securityLink));
        break;
      default:
        addLine("Finding:", sanitizeTerminalText(formatClawHubReasonCode(reason)));
        break;
    }
  }
  if (params.assessment.disposition === "review-recommended") {
    for (const notice of params.assessment.notices) {
      addLine("Status:", sanitizeTerminalText(notice));
    }
  }
  if (params.trust.blockedFromDownload) {
    addLine("Finding:", "Download disabled by ClawHub for this release");
  }
  if (lines.length === 0) {
    for (const reason of params.assessment.riskReasons) {
      addLine("Finding:", sanitizeTerminalText(reason));
    }
  }
  return lines;
}

function formatClawHubRawLinkLine(label: string, url: string): string {
  return `  ${theme.muted(padRight(label, CLAWHUB_RAW_LINK_LABEL_WIDTH))} ${theme.info(sanitizeTerminalText(url))}`;
}

function formatClawHubRawLinks(params: {
  subject: ClawHubTrustSubject;
  links: ClawHubSecurityLinks;
}): string {
  const subjectUrl = sanitizeTerminalText(params.links.subject);
  if ("security" in params.links) {
    return [
      "",
      "Links:",
      formatClawHubRawLinkLine("Skill", subjectUrl),
      formatClawHubRawLinkLine("Security details", params.links.security),
    ].join("\n");
  }
  return [
    "",
    "Links:",
    formatClawHubRawLinkLine("Plugin", subjectUrl),
    formatClawHubRawLinkLine("Security scan", params.links.clawscan),
  ].join("\n");
}

function formatClawHubTrustWarning(params: {
  baseUrl?: string;
  subject: ClawHubTrustSubject;
  version: string;
  trust: ClawHubPackageSecurityTrust;
  assessment: ClawHubTrustAssessment;
  mode?: "install" | "update";
  terminalLinks?: boolean;
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
  const evidenceLines = formatClawHubTrustEvidenceLines({
    trust: params.trust,
    assessment: params.assessment,
    links,
    terminalLinks: params.terminalLinks,
  });
  const noun = params.subject.kind;
  if (params.assessment.disposition === "blocked") {
    const malicious = hasMaliciousClawHubTrustSignal(params.trust);
    const blockedActionLines =
      params.mode === "update"
        ? malicious
          ? [
              `Latest ${noun} version is marked malicious; OpenClaw will not download it.`,
              `Uninstall the installed ${noun} unless you have independently reviewed it.`,
            ]
          : [`Latest ${noun} version is blocked by ClawHub; OpenClaw will not download it.`]
        : [`OpenClaw will not install this ${noun} release from ClawHub.`];
    const blockedTitle = malicious
      ? "BLOCKED - ClawHub flagged this release as malicious"
      : "BLOCKED - ClawHub blocked this release";
    return [
      renderClawHubTrustBox(
        blockedTitle,
        [
          ...evidenceLines,
          "",
          ...blockedActionLines,
          "Review the ClawHub security details or contact the package maintainer if you believe this is wrong.",
        ],
        params.assessment.disposition,
      ),
      formatClawHubRawLinks({ subject: params.subject, links }),
    ].join("\n");
  }
  if (params.assessment.disposition === "review-required") {
    const riskContext =
      params.subject.kind === "plugin"
        ? "This plugin is not marked malicious, but ClawHub found security findings or a large local system blast radius."
        : "This skill is not marked malicious, but ClawHub found security findings or a large instruction/tool-use blast radius.";
    return [
      renderClawHubTrustBox(
        "WARNING - ClawHub found security risks in this release",
        [
          ...evidenceLines,
          "",
          riskContext,
          `Review the ClawHub security details before ${params.mode === "update" ? "updating" : "installing"}.`,
        ],
        params.assessment.disposition,
      ),
      formatClawHubRawLinks({ subject: params.subject, links }),
    ].join("\n");
  }
  return [
    renderClawHubTrustBox(
      "REVIEW RECOMMENDED - ClawHub has not completed a fresh clean check",
      [
        ...evidenceLines,
        "",
        `This does not mean the ${noun} is malicious, but ClawHub has not completed a clean security check for this release yet.`,
        `Review the ClawHub security details before ${params.mode === "update" ? "updating" : "installing"}.`,
      ],
      params.assessment.disposition,
    ),
    formatClawHubRawLinks({ subject: params.subject, links }),
  ].join("\n");
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
  return {
    package: {
      name: params.packageName,
      family: "skill",
      ...(displayName ? { displayName } : {}),
    },
    release: {
      version: params.version,
    },
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

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readOptionalStringField(value: unknown, field: string): string | undefined {
  const record = readObject(value);
  return normalizeOptionalString(record?.[field]);
}

function readOptionalNumberField(value: unknown, field: string): number | undefined {
  const record = readObject(value);
  const raw = record?.[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function mapSkillVerificationSecurityForVerdict(
  verification: ClawHubSkillVerificationResponse,
  opts?: { allowCleanCardOnlyPass?: boolean },
): unknown {
  const security = readObject(verification.security);
  if (!security || Object.hasOwn(security, "passed")) {
    return verification.security;
  }
  const status =
    normalizeOptionalString(security.status) ?? normalizeOptionalString(security.rawStatus);
  const decisionPass =
    verification.ok && normalizeClawHubTrustToken(verification.decision) === "pass";
  if (!status || (!decisionPass && opts?.allowCleanCardOnlyPass !== true)) {
    return verification.security;
  }
  // The owner-qualified fallback uses the older verify endpoint, whose pass
  // decision plus concrete status predates the batched verdict `passed` flag.
  return { ...security, passed: true };
}

function hasOnlyNonSecuritySkillVerifyReasons(reasons: readonly string[]): boolean {
  return (
    reasons.length > 0 &&
    reasons.every((reason) =>
      CLAWHUB_NON_SECURITY_SKILL_VERIFY_REASONS.has(normalizeClawHubTrustToken(reason)),
    )
  );
}

function isOwnerQualifiedSkillNotFoundVerdict(item: ClawHubSkillSecurityVerdictItem): boolean {
  return item.error?.code === "skill_not_found";
}

function mapSkillVerificationToSecurityVerdictItem(params: {
  verification: ClawHubSkillVerificationResponse;
  slug: string;
  ownerHandle: string;
  version: string;
}): ClawHubSkillSecurityVerdictItem {
  const skill = readObject(params.verification.skill);
  const publisher = readObject(params.verification.publisher);
  const versionRecord = readObject(params.verification.version);
  const pageUrl = normalizeOptionalString(params.verification.pageUrl);
  const reasons = params.verification.reasons
    .map((reason) => normalizeOptionalString(reason))
    .filter((reason): reason is string => Boolean(reason));
  const securityStatus = normalizeClawHubTrustToken(
    readOptionalStringField(params.verification.security, "status") ??
      readOptionalStringField(params.verification.security, "rawStatus"),
  );
  const cardOnlyCleanFailure =
    !params.verification.ok &&
    securityStatus === "clean" &&
    hasOnlyNonSecuritySkillVerifyReasons(reasons);
  const verifiedVersion =
    normalizeOptionalString(params.verification.version) ??
    readOptionalStringField(versionRecord, "version");
  return {
    ok: cardOnlyCleanFailure ? true : params.verification.ok,
    decision: cardOnlyCleanFailure ? "pass" : params.verification.decision,
    reasons: cardOnlyCleanFailure ? [] : reasons,
    requestedSlug: params.slug,
    requestedVersion: params.version,
    slug:
      normalizeOptionalString(params.verification.slug) ?? readOptionalStringField(skill, "slug"),
    version: verifiedVersion ?? (cardOnlyCleanFailure ? params.version : null),
    displayName:
      normalizeOptionalString(params.verification.displayName) ??
      readOptionalStringField(skill, "displayName"),
    publisherHandle:
      normalizeOptionalString(params.verification.publisherHandle) ??
      readOptionalStringField(publisher, "handle") ??
      params.ownerHandle,
    publisherDisplayName:
      normalizeOptionalString(params.verification.publisherDisplayName) ??
      readOptionalStringField(publisher, "displayName"),
    createdAt:
      params.verification.createdAt ?? readOptionalNumberField(versionRecord, "createdAt") ?? null,
    checkedAt: readOptionalNumberField(params.verification.security, "checkedAt") ?? null,
    ...(pageUrl ? { skillUrl: pageUrl } : {}),
    ...(pageUrl
      ? {
          securityAuditUrl: `${pageUrl}/security-audit?version=${encodeURIComponent(params.version)}`,
        }
      : {}),
    security: mapSkillVerificationSecurityForVerdict(params.verification, {
      allowCleanCardOnlyPass: cardOnlyCleanFailure,
    }),
  };
}

async function fetchOwnerQualifiedSkillSecurityFallback(params: {
  subject: {
    kind: "skill";
    packageName: string;
    ownerHandle?: string;
  };
  version: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
}): Promise<ClawHubFetchedSubjectSecurity> {
  const ownerHandle = params.subject.ownerHandle;
  if (!ownerHandle) {
    throw new Error("owner-qualified skill fallback requires ownerHandle");
  }
  const verification = await fetchClawHubSkillVerification({
    slug: params.subject.packageName,
    ownerHandle,
    version: params.version,
    baseUrl: params.baseUrl,
    token: params.token,
    timeoutMs: params.timeoutMs,
  });
  const item = mapSkillVerificationToSecurityVerdictItem({
    verification,
    slug: params.subject.packageName,
    ownerHandle,
    version: params.version,
  });
  return {
    security: mapSkillSecurityVerdictToPackageSecurity({
      item,
      packageName: params.subject.packageName,
      ownerHandle,
      version: params.version,
    }),
    links: resolveSkillSecurityLinks(item),
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
    return {
      security: await fetchClawHubPackageSecurity({
        name: params.subject.packageName,
        version: params.version,
        baseUrl: params.baseUrl,
        token: params.token,
        timeoutMs: params.timeoutMs,
      }),
    };
  }
  const response = await fetchClawHubSkillSecurityVerdicts({
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
  if (response.items.length !== 1) {
    throw new Error(
      `ClawHub skill trust check for "${formatClawHubReleaseLabel(params.subject.packageName, params.version)}" returned ${response.items.length} verdicts.`,
    );
  }
  const item = response.items[0];
  if (!item) {
    throw new Error(
      `ClawHub skill trust check for "${formatClawHubReleaseLabel(params.subject.packageName, params.version)}" returned no verdict.`,
    );
  }
  if (params.subject.ownerHandle && isOwnerQualifiedSkillNotFoundVerdict(item)) {
    return await fetchOwnerQualifiedSkillSecurityFallback({
      subject: {
        kind: "skill",
        packageName: params.subject.packageName,
        ownerHandle: params.subject.ownerHandle,
      },
      version: params.version,
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
    });
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

export async function ensureClawHubPackageTrustAcknowledged(params: {
  subject: ClawHubTrustSubject;
  version: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  acknowledgeClawHubRisk?: boolean;
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
  logger?: ClawHubInstallLogger;
  mode?: "install" | "update";
}): Promise<ClawHubTrustFailure | ClawHubTrustAcceptedResult> {
  let trust: ClawHubPackageSecurityTrust;
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
  const acceptTrust = (opts?: {
    acknowledgedAt?: string;
    warning?: string;
  }): ClawHubTrustAcceptedResult => ({
    ok: true,
    trustInstallRecordFields: buildClawHubTrustInstallRecordFields({
      trust,
      assessment,
      checkedAt,
      ...(opts?.acknowledgedAt ? { acknowledgedAt: opts.acknowledgedAt } : {}),
    }),
    ...(opts?.warning ? { warning: opts.warning } : {}),
  });
  if (assessment.disposition === "clean") {
    return acceptTrust();
  }

  const terminalWarning = formatClawHubTrustWarning({
    baseUrl: params.baseUrl,
    subject: params.subject,
    version: params.version,
    trust,
    assessment,
    mode: params.mode,
    terminalLinks: params.logger?.terminalLinks,
    links: warningLinks,
  });
  const warning = stripAnsi(
    formatClawHubTrustWarning({
      baseUrl: params.baseUrl,
      subject: params.subject,
      version: params.version,
      trust,
      assessment,
      mode: params.mode,
      terminalLinks: false,
      links: warningLinks,
    }),
  );
  params.logger?.warn?.(terminalWarning);
  if (assessment.disposition === "review-recommended") {
    return acceptTrust({ warning });
  }
  if (assessment.disposition === "blocked") {
    const blockedVerb = params.mode === "update" ? "update" : "install";
    return {
      ok: false,
      error: `ClawHub blocked this release; ${blockedVerb} was not started.`,
      code: CLAWHUB_TRUST_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED,
      warning,
      version: params.version,
    };
  }
  if (params.acknowledgeClawHubRisk) {
    return acceptTrust({ acknowledgedAt: new Date().toISOString(), warning });
  }

  const acknowledged = params.onClawHubRisk
    ? await params.onClawHubRisk({
        packageName: packageLabel,
        version: params.version,
        trust,
        acknowledgementKind:
          assessment.disposition === "review-required" ? "type-package" : "confirm",
        warning,
      })
    : false;
  if (acknowledged) {
    return acceptTrust({ acknowledgedAt: new Date().toISOString(), warning });
  }
  return {
    ok: false,
    error: `${params.mode === "update" ? "Update" : "Install"} cancelled; rerun with --acknowledge-clawhub-risk to continue after reviewing the warning.`,
    code: CLAWHUB_TRUST_ERROR_CODE.CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED,
    warning,
    version: params.version,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
