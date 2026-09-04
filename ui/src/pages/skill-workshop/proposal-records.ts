import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { formatBytes } from "../../lib/agents/display.ts";
import type {
  SkillWorkshopEvaluation,
  SkillWorkshopProposal,
  SkillWorkshopProposalStatus,
} from "../../lib/skill-workshop/index.ts";

type SkillProposalStatus = SkillWorkshopProposalStatus;
type SkillProposalKind = SkillWorkshopProposal["kind"];
type SkillProposalScanState = "pending" | "clean" | "failed" | "quarantined";

type SkillProposalManifestEntry = {
  id: string;
  kind: SkillProposalKind;
  status: SkillProposalStatus;
  title: string;
  description: string;
  skillName: string;
  skillKey: string;
  createdAt: string;
  updatedAt: string;
  scanState: SkillProposalScanState;
};

export type SkillProposalManifest = {
  schema: "openclaw.skill-workshop.proposals-manifest.v1";
  updatedAt: string;
  proposals: SkillProposalManifestEntry[];
};

type SkillProposalSupportFileRecord = {
  path: string;
  sizeBytes: number;
};

type SkillProposalOrigin = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
};

type SkillProposalRecord = {
  id: string;
  kind: SkillProposalKind;
  status: SkillProposalStatus;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  proposedVersion: string;
  draftHash: string;
  evaluation?: SkillWorkshopEvaluation;
  origin?: SkillProposalOrigin;
  supportFiles?: SkillProposalSupportFileRecord[];
  target: {
    skillName: string;
    skillKey: string;
  };
};

type SkillProposalSupportFile = {
  path: string;
  content: string;
};

export type SkillProposalInspectResult = {
  record: SkillProposalRecord;
  revisionHash?: string;
  content: string;
  supportFiles?: SkillProposalSupportFile[];
};

export type SkillProposalEvaluateResult = {
  record: SkillProposalRecord;
  evaluation: SkillWorkshopEvaluation;
};

export function parseDateMs(value: string | undefined): number {
  return parseDateStringTimestampMs(value) ?? Date.now();
}

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function recencyGroup(ms: number): SkillWorkshopProposal["recencyGroup"] {
  const today = startOfLocalDay(Date.now());
  const day = startOfLocalDay(ms);
  if (day === today) {
    return "today";
  }
  if (day === today - 24 * 60 * 60 * 1000) {
    return "yesterday";
  }
  return "earlier";
}

function compactAgeLabel(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) {
    return "now";
  }
  if (min < 60) {
    return `${min}m`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h`;
  }
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

function proposedVersionNumber(value: string | undefined): number {
  const parsed = Number.parseInt((value ?? "").replace(/^v/i, ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function stripProposalFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function supportFilesFromInspect(
  result: SkillProposalInspectResult,
): SkillWorkshopProposal["supportFiles"] {
  const sizes = new Map(
    (result.record.supportFiles ?? []).map((file) => [file.path, file.sizeBytes]),
  );
  return (result.supportFiles ?? []).map((file) => ({
    path: file.path,
    size: formatBytes(Math.max(0, sizes.get(file.path) ?? byteLength(file.content)), {
      fallback: "0 B",
      maxUnit: "kilo",
      fractionDigits: (_value, unit) => (unit === "byte" ? null : 1),
    }),
    contents: file.content,
  }));
}

export function proposalFromManifest(
  entry: SkillProposalManifestEntry,
  previous: SkillWorkshopProposal | undefined,
): SkillWorkshopProposal {
  const updatedAt = parseDateMs(entry.updatedAt);
  const createdAt = parseDateMs(entry.createdAt);
  const previousIsCurrent = previous?.updatedAt === updatedAt;
  return {
    key: entry.id,
    kind: entry.kind,
    slug: entry.skillKey,
    name: entry.title || entry.skillName,
    oneLine: entry.description,
    body: previousIsCurrent ? previous.body : "",
    bodyLoaded: previousIsCurrent ? previous.bodyLoaded : false,
    status: entry.status,
    ...(previousIsCurrent && previous.origin ? { origin: previous.origin } : {}),
    version: previousIsCurrent ? previous.version : 1,
    revisionHash: previousIsCurrent ? previous.revisionHash : null,
    ...(previousIsCurrent && previous.evaluation ? { evaluation: previous.evaluation } : {}),
    createdAt,
    updatedAt,
    recencyGroup: recencyGroup(updatedAt || createdAt),
    ageLabel: compactAgeLabel(updatedAt || createdAt),
    supportFiles: previousIsCurrent ? previous.supportFiles : [],
    isNew: previous?.isNew ?? false,
  };
}

export function proposalFromInspect(
  result: SkillProposalInspectResult,
  previous: SkillWorkshopProposal | undefined,
): SkillWorkshopProposal {
  const record = result.record;
  const updatedAt = parseDateMs(record.updatedAt);
  const createdAt = parseDateMs(record.createdAt);
  const revisionHash = result.revisionHash?.trim() || null;
  const evaluation =
    record.evaluation?.revisionHash === revisionHash
      ? record.evaluation
      : previous?.evaluation?.revisionHash === revisionHash
        ? previous.evaluation
        : undefined;
  return {
    key: record.id,
    kind: record.kind,
    slug: record.target.skillKey,
    name: record.title || record.target.skillName,
    oneLine: record.description,
    body: stripProposalFrontmatter(result.content),
    bodyLoaded: true,
    status: record.status,
    ...(record.origin ? { origin: record.origin } : {}),
    version: proposedVersionNumber(record.proposedVersion),
    revisionHash,
    ...(evaluation ? { evaluation } : {}),
    createdAt,
    updatedAt,
    recencyGroup: recencyGroup(updatedAt || createdAt),
    ageLabel: compactAgeLabel(updatedAt || createdAt),
    supportFiles: supportFilesFromInspect(result),
    isNew: previous?.isNew ?? false,
  };
}

export function proposalFromEvaluation(
  result: SkillProposalEvaluateResult,
  previous: SkillWorkshopProposal,
): SkillWorkshopProposal {
  const record = result.record;
  const updatedAt = parseDateMs(record.updatedAt);
  const createdAt = parseDateMs(record.createdAt);
  return {
    key: record.id,
    kind: record.kind,
    slug: record.target.skillKey,
    name: record.title || record.target.skillName,
    oneLine: record.description,
    body: previous.body,
    bodyLoaded: previous.bodyLoaded,
    status: record.status,
    ...(record.origin
      ? { origin: record.origin }
      : previous.origin
        ? { origin: previous.origin }
        : {}),
    version: proposedVersionNumber(record.proposedVersion),
    revisionHash: result.evaluation.revisionHash,
    evaluation: result.evaluation,
    createdAt,
    updatedAt,
    recencyGroup: recencyGroup(updatedAt || createdAt),
    ageLabel: compactAgeLabel(updatedAt || createdAt),
    supportFiles: previous.supportFiles,
    isNew: previous.isNew,
  };
}
