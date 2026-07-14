// QA Lab WhatsApp report, redaction, and artifact formatting.
import fs from "node:fs/promises";
import type { WhatsAppQaDriverObservedMessage } from "@openclaw/whatsapp/api.js";
import { redactQaLiveLaneDetails } from "../shared/live-artifacts.js";
import {
  buildWhatsAppQaScenarioResultBase,
  type WhatsAppObservedMessage,
  type WhatsAppObservedMessageArtifact,
  type WhatsAppObservedReactionArtifact,
  type WhatsAppQaPreScenarioPhase,
  type WhatsAppQaScenarioDefinition,
  type WhatsAppQaScenarioResult,
} from "./whatsapp-live.contracts.js";

export function toObservedWhatsAppArtifacts(params: {
  includeContent: boolean;
  messages: WhatsAppObservedMessage[];
  redactMetadata: boolean;
}): WhatsAppObservedMessageArtifact[] {
  return params.messages.map((message) => ({
    approvalState: message.approvalState,
    fromPhoneE164: params.redactMetadata ? undefined : message.fromPhoneE164,
    hasMedia: message.hasMedia,
    kind: message.kind,
    matchedScenario: message.matchedScenario,
    mediaFileName: params.redactMetadata ? undefined : message.mediaFileName,
    mediaType: message.mediaType,
    messageId: params.redactMetadata ? undefined : message.messageId,
    observedAt: message.observedAt,
    poll: params.includeContent ? message.poll : undefined,
    quoted: formatObservedWhatsAppQuotedArtifact(message.quoted, {
      includeContent: params.includeContent,
      redactMetadata: params.redactMetadata,
    }),
    reaction: formatObservedWhatsAppReactionArtifact(message.reaction, {
      includeContent: params.includeContent,
      redactMetadata: params.redactMetadata,
    }),
    scenarioId: message.scenarioId,
    scenarioTitle: message.scenarioTitle,
    text: params.includeContent ? message.text : undefined,
  }));
}

function formatObservedWhatsAppReactionArtifact(
  reaction: WhatsAppQaDriverObservedMessage["reaction"],
  params: { includeContent: boolean; redactMetadata: boolean },
): WhatsAppObservedReactionArtifact | undefined {
  if (!reaction) {
    return undefined;
  }
  const artifact: WhatsAppObservedReactionArtifact = {};
  if (params.includeContent) {
    artifact.emoji = reaction.emoji;
  }
  if (reaction.fromMe !== undefined) {
    artifact.fromMe = reaction.fromMe;
  }
  if (!params.redactMetadata) {
    if (reaction.messageId !== undefined) {
      artifact.messageId = reaction.messageId;
    }
    if (reaction.participant !== undefined) {
      artifact.participant = reaction.participant;
    }
  }
  return artifact;
}

function formatObservedWhatsAppQuotedArtifact(
  quoted: WhatsAppQaDriverObservedMessage["quoted"],
  params: { includeContent: boolean; redactMetadata: boolean },
) {
  if (!quoted) {
    return undefined;
  }
  return {
    messageId: params.redactMetadata ? undefined : quoted.messageId,
    participant: params.redactMetadata ? undefined : quoted.participant,
    text: params.includeContent ? quoted.text : undefined,
  };
}

export function renderWhatsAppQaMarkdown(params: {
  cleanupIssues: string[];
  credentialFingerprint?: string;
  credentialSource: "convex" | "env";
  finishedAt: string;
  gatewayDebugDirPath?: string;
  redactMetadata: boolean;
  scenarios: WhatsAppQaScenarioResult[];
  startedAt: string;
  sutPhoneE164?: string;
}) {
  const lines = [
    "# WhatsApp QA Report",
    "",
    `- Credential source: \`${params.credentialSource}\``,
    ...(params.credentialFingerprint
      ? [`- Credential fingerprint: \`${params.credentialFingerprint}\``]
      : []),
    `- SUT phone: \`${params.redactMetadata ? "<redacted>" : (params.sutPhoneE164 ?? "<unavailable>")}\``,
    `- Metadata redaction: \`${params.redactMetadata ? "enabled" : "disabled"}\``,
    `- Started: ${params.startedAt}`,
    `- Finished: ${params.finishedAt}`,
  ];
  if (params.gatewayDebugDirPath) {
    lines.push(`- Gateway debug artifacts: \`${params.gatewayDebugDirPath}\``);
  }
  if (params.cleanupIssues.length > 0) {
    lines.push("", "## Cleanup issues", "");
    for (const issue of params.cleanupIssues) {
      lines.push(`- ${issue}`);
    }
  }
  lines.push("", "## Scenarios", "");
  for (const scenario of params.scenarios) {
    lines.push(`### ${scenario.title}`, "");
    lines.push(`- Status: ${scenario.status}`);
    lines.push(`- Posture: ${scenario.posture}`);
    lines.push(`- Details: ${scenario.details}`);
    if (scenario.rttMs !== undefined) {
      lines.push(`- RTT: ${scenario.rttMs}ms`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function redactWhatsAppQaScenarioResults(
  scenarios: readonly WhatsAppQaScenarioResult[],
): WhatsAppQaScenarioResult[] {
  return scenarios.map((scenario) => ({
    ...scenario,
    details: redactWhatsAppQaScenarioDetails(scenario.details),
  }));
}

const SAFE_WHATSAPP_DRIVER_DIAGNOSTICS_PATTERN =
  /observed \d+ WhatsApp driver message\(s\) after (?:(?:pending|resolved) approval )?wait lower bound(?:: [-A-Za-z0-9_#:=()., +;/]+)?/u;
const SAFE_WHATSAPP_PRE_SCENARIO_FAILURE_PATTERN =
  /^WhatsApp QA failed during (?:auth archive unpack|credential heartbeat start|credential lease acquisition|driver session start|scenario execution)$/u;
const SAFE_WHATSAPP_CREDENTIAL_POOL_EXHAUSTED_PATTERN =
  /Convex credential pool exhausted for kind "whatsapp" after \d+ms\./u;

export function formatWhatsAppPreScenarioFailureLabel(phase: WhatsAppQaPreScenarioPhase) {
  return `WhatsApp QA failed during ${phase}`;
}

function isRedactionSafeWhatsAppScenarioDetailSegment(segment: string) {
  return (
    /^no reply$/u.test(segment) ||
    /^reply matched in \d+ms$/u.test(segment) ||
    /^observed \d+ SUT message\(s\) after settle$/u.test(segment)
  );
}

function redactWhatsAppQaScenarioDetails(details: string) {
  const normalized = details.trim();
  const firstLine = normalized.split(/\r?\n/u, 1)[0] ?? "";
  const separatorIndex = firstLine.indexOf(":");
  const preScenarioFailureLabel =
    separatorIndex < 0 ? firstLine.trim() : firstLine.slice(0, separatorIndex).trim();
  if (SAFE_WHATSAPP_PRE_SCENARIO_FAILURE_PATTERN.test(preScenarioFailureLabel)) {
    const poolExhausted = firstLine.match(SAFE_WHATSAPP_CREDENTIAL_POOL_EXHAUSTED_PATTERN);
    return poolExhausted
      ? `${preScenarioFailureLabel}: ${poolExhausted[0]}`
      : preScenarioFailureLabel;
  }
  const safeDriverDiagnostics = normalized.match(SAFE_WHATSAPP_DRIVER_DIAGNOSTICS_PATTERN);
  if (safeDriverDiagnostics) {
    return safeDriverDiagnostics[0];
  }
  const safeSegments = normalized
    .split(";")
    .map((segment) => segment.trim())
    .filter(isRedactionSafeWhatsAppScenarioDetailSegment);
  return safeSegments.length > 0 ? safeSegments.join("; ") : redactQaLiveLaneDetails();
}

function redactWhatsAppQaCleanupIssue(issue: string) {
  const firstLine = issue.split(/\r?\n/u, 1)[0] ?? "";
  const separatorIndex = firstLine.indexOf(":");
  const label = separatorIndex < 0 ? "" : firstLine.slice(0, separatorIndex).trim();
  if (!label) {
    return redactQaLiveLaneDetails();
  }
  if (SAFE_WHATSAPP_PRE_SCENARIO_FAILURE_PATTERN.test(label)) {
    const poolExhausted = firstLine.match(SAFE_WHATSAPP_CREDENTIAL_POOL_EXHAUSTED_PATTERN);
    if (poolExhausted) {
      return `${label}: ${poolExhausted[0]}`;
    }
  }
  return `${label}: ${redactQaLiveLaneDetails()}`;
}

function redactWhatsAppQaCleanupIssues(issues: readonly string[]) {
  return issues.map(redactWhatsAppQaCleanupIssue);
}

export function createMissingGroupJidScenarioResult(params: {
  explicitScenarioSelection: boolean;
  scenario: WhatsAppQaScenarioDefinition;
}): WhatsAppQaScenarioResult {
  return {
    ...buildWhatsAppQaScenarioResultBase(params.scenario),
    status: params.explicitScenarioSelection ? "fail" : "skip",
    details: params.explicitScenarioSelection
      ? "requested scenario requires groupJid in the WhatsApp QA credential payload"
      : "requires groupJid in the WhatsApp QA credential payload",
  };
}

export function appendPreScenarioFailureResults(params: {
  details: string;
  scenarioResults: WhatsAppQaScenarioResult[];
  scenarios: WhatsAppQaScenarioDefinition[];
}) {
  const recordedScenarioIds = new Set(params.scenarioResults.map((result) => result.id));
  const pendingScenarios = params.scenarios.filter(
    (scenario) => !recordedScenarioIds.has(scenario.id),
  );
  const failedScenarios =
    pendingScenarios.length > 0 ? pendingScenarios : params.scenarios.slice(0, 1);
  for (const scenario of failedScenarios) {
    params.scenarioResults.push({
      ...buildWhatsAppQaScenarioResultBase(scenario),
      status: "fail",
      details: params.details,
    });
  }
}

export async function hasWhatsAppGatewayDebugArtifacts(gatewayDebugDirPath: string) {
  try {
    const entries = await fs.readdir(gatewayDebugDirPath);
    return entries.length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function buildPublishedWhatsAppQaRunView(params: {
  cleanupIssues: string[];
  gatewayDebugDirPath: string;
  preservedGatewayDebugArtifacts: boolean;
  redactMetadata: boolean;
  scenarioResults: WhatsAppQaScenarioResult[];
}) {
  const publishedCleanupIssues = params.redactMetadata
    ? redactWhatsAppQaCleanupIssues(params.cleanupIssues)
    : params.cleanupIssues;
  const publishedScenarioResults = params.redactMetadata
    ? redactWhatsAppQaScenarioResults(params.scenarioResults)
    : params.scenarioResults;
  const gatewayDebugDirPath =
    params.preservedGatewayDebugArtifacts &&
    (await hasWhatsAppGatewayDebugArtifacts(params.gatewayDebugDirPath))
      ? params.gatewayDebugDirPath
      : undefined;
  return {
    cleanupIssues: publishedCleanupIssues,
    gatewayDebugDirPath,
    scenarioResults: publishedScenarioResults,
  };
}

export function formatWhatsAppScenarioProgressLine(params: {
  details?: string;
  index: number;
  scenario: WhatsAppQaScenarioDefinition;
  status: "fail" | "pass" | "skip" | "start";
  total: number;
}) {
  const prefix = `[whatsapp-qa] [${params.index}/${params.total}] ${params.status}`;
  const detailSuffix = params.details ? ` - ${params.details}` : "";
  return `${prefix} ${params.scenario.id}: ${params.scenario.title}${detailSuffix}`;
}

export function formatWhatsAppScenarioProgressDetails(params: {
  details: string;
  redactMetadata: boolean;
}) {
  return params.redactMetadata ? redactWhatsAppQaScenarioDetails(params.details) : params.details;
}
