// Control UI controller manages skill workshop gateway state.
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { AgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationGateway } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatBytes } from "../../lib/agents/display.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import type {
  SkillWorkshopAction,
  SkillWorkshopEvaluation,
  SkillWorkshopProposal,
  SkillWorkshopProposalStatus,
} from "../../lib/skill-workshop/index.ts";
import { createSkillWorkshopHistoryScanState, type SkillWorkshopState } from "./state.ts";
export {
  createSkillWorkshopState,
  skillWorkshopRouteData,
  type SkillWorkshopRouteData,
  type SkillWorkshopState,
} from "./state.ts";

const SKILL_WORKSHOP_NOTICE_MS = 2800;

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

type SkillProposalManifest = {
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

type SkillProposalInspectResult = {
  record: SkillProposalRecord;
  revisionHash?: string;
  content: string;
  supportFiles?: SkillProposalSupportFile[];
};

type SkillProposalEvaluateResult = {
  record: SkillProposalRecord;
  evaluation: SkillWorkshopEvaluation;
};

export type SkillWorkshopContext = {
  gateway: ApplicationGateway;
  agentSelection: Pick<AgentSelectionCapability, "state">;
};

function skillWorkshopAgentParams(context: SkillWorkshopContext): { agentId: string } {
  const snapshot = context.gateway.snapshot;
  const sessionAgentId = parseAgentSessionKey(snapshot.sessionKey)?.agentId;
  const selectedAgentId = context.agentSelection.state.selectedId;
  return {
    agentId: sessionAgentId
      ? normalizeAgentId(sessionAgentId)
      : selectedAgentId
        ? normalizeAgentId(selectedAgentId)
        : resolveUiSelectedGlobalAgentId(snapshot),
  };
}

export function resolveSkillWorkshopAgentId(context: SkillWorkshopContext): string {
  return skillWorkshopAgentParams(context).agentId;
}

function loadedSkillWorkshopAgentParams(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
): { agentId: string } {
  return {
    agentId: state.skillWorkshopAgentId ?? skillWorkshopAgentParams(context).agentId,
  };
}

function resetSkillWorkshopAgentScope(state: SkillWorkshopState, agentId: string): void {
  state.skillWorkshopAgentId = agentId;
  state.skillWorkshopLoaded = false;
  state.skillWorkshopProposals = [];
  state.skillWorkshopSelectedKey = null;
  state.skillWorkshopInspectingKey = null;
  state.skillWorkshopRevisionKey = null;
  state.skillWorkshopRevisionDraft = "";
  state.skillWorkshopFilePreviewKey = null;
  state.skillWorkshopFilePreviewQuery = "";
  state.skillWorkshopHistoryScan = createSkillWorkshopHistoryScanState();
}

function parseDateMs(value: string | undefined): number {
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

function proposalFromManifest(
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

function proposalFromInspect(
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

function proposalFromEvaluation(
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

function mergeProposal(state: SkillWorkshopState, proposal: SkillWorkshopProposal): void {
  const proposals = state.skillWorkshopProposals;
  const index = proposals.findIndex((item) => item.key === proposal.key);
  if (index < 0) {
    state.skillWorkshopProposals = [proposal, ...proposals];
    return;
  }
  state.skillWorkshopProposals = [
    ...proposals.slice(0, index),
    proposal,
    ...proposals.slice(index + 1),
  ];
}

function clearActionNoticeTimer(state: SkillWorkshopState): void {
  if (state.skillWorkshopActionNoticeTimer) {
    globalThis.clearTimeout(state.skillWorkshopActionNoticeTimer);
    state.skillWorkshopActionNoticeTimer = null;
  }
}

function showActionNotice(
  state: SkillWorkshopState,
  proposal: SkillWorkshopProposal | undefined,
  label: string,
): void {
  if (!proposal) {
    return;
  }
  clearActionNoticeTimer(state);
  state.skillWorkshopActionNotice = {
    key: proposal.key,
    label,
    slug: proposal.slug || proposal.name,
  };
  state.skillWorkshopActionNoticeTimer = globalThis.setTimeout(() => {
    if (state.skillWorkshopActionNotice?.key === proposal.key) {
      state.skillWorkshopActionNotice = null;
    }
    state.skillWorkshopActionNoticeTimer = null;
  }, SKILL_WORKSHOP_NOTICE_MS);
}

export function countSkillWorkshopProposals(
  proposals: SkillWorkshopProposal[],
): Record<"all" | SkillProposalStatus, number> {
  return proposals.reduce(
    (counts, proposal) => {
      counts.all += 1;
      counts[proposal.status] += 1;
      return counts;
    },
    { all: 0, pending: 0, applied: 0, rejected: 0, quarantined: 0, stale: 0 },
  );
}

export async function loadSkillWorkshopProposals(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  options?: { force?: boolean },
): Promise<void> {
  const snapshot = context.gateway.snapshot;
  const client = snapshot.client;
  if (!client || snapshot.phase !== "connected") {
    return;
  }
  const requestAgentId = skillWorkshopAgentParams(context).agentId;
  if (state.skillWorkshopAgentId !== requestAgentId) {
    resetSkillWorkshopAgentScope(state, requestAgentId);
  }
  if (state.skillWorkshopLoading) {
    return;
  }
  if (state.skillWorkshopLoaded && !options?.force) {
    return;
  }
  state.skillWorkshopLoading = true;
  state.skillWorkshopError = null;
  try {
    const result = await client.request<SkillProposalManifest>("skills.proposals.list", {
      agentId: requestAgentId,
    });
    if (skillWorkshopAgentParams(context).agentId !== requestAgentId) {
      return;
    }
    const previousByKey = new Map(
      state.skillWorkshopProposals.map((proposal) => [proposal.key, proposal]),
    );
    const proposals = (result.proposals ?? [])
      .toSorted((a, b) => parseDateMs(b.updatedAt) - parseDateMs(a.updatedAt))
      .map((entry) => proposalFromManifest(entry, previousByKey.get(entry.id)));
    state.skillWorkshopProposals = proposals;
    state.skillWorkshopLoaded = true;
    if (!proposals.some((proposal) => proposal.key === state.skillWorkshopSelectedKey)) {
      state.skillWorkshopSelectedKey = proposals[0]?.key ?? null;
    }
    if (state.skillWorkshopSelectedKey) {
      await loadSkillWorkshopProposalDetail(state, context, state.skillWorkshopSelectedKey);
    }
  } catch (err) {
    state.skillWorkshopError = formatUiError(err);
  } finally {
    state.skillWorkshopLoading = false;
    if (skillWorkshopAgentParams(context).agentId !== requestAgentId) {
      void loadSkillWorkshopProposals(state, context, { force: true });
    }
  }
}

async function loadSkillWorkshopProposalDetail(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  proposalId: string,
  options?: { force?: boolean },
): Promise<boolean> {
  const snapshot = context.gateway.snapshot;
  const client = snapshot.client;
  if (
    !client ||
    snapshot.phase !== "connected" ||
    state.skillWorkshopInspectingKey === proposalId
  ) {
    return false;
  }
  const existing = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
  if (existing?.body && !options?.force) {
    return true;
  }
  const requestAgentId = loadedSkillWorkshopAgentParams(state, context).agentId;
  if (state.skillWorkshopAgentId === null) {
    state.skillWorkshopAgentId = requestAgentId;
  }
  state.skillWorkshopInspectingKey = proposalId;
  state.skillWorkshopError = null;
  try {
    const requestParams = { agentId: requestAgentId, proposalId };
    const result = await client.request<SkillProposalInspectResult>(
      "skills.proposals.inspect",
      requestParams,
    );
    if (
      state.skillWorkshopAgentId !== requestAgentId ||
      state.skillWorkshopInspectingKey !== proposalId
    ) {
      return false;
    }
    mergeProposal(state, proposalFromInspect(result, existing));
    return true;
  } catch (err) {
    if (state.skillWorkshopAgentId === requestAgentId) {
      state.skillWorkshopError = formatUiError(err);
    }
    return false;
  } finally {
    if (
      state.skillWorkshopAgentId === requestAgentId &&
      state.skillWorkshopInspectingKey === proposalId
    ) {
      state.skillWorkshopInspectingKey = null;
    }
  }
}

export async function selectSkillWorkshopProposal(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  proposalId: string,
): Promise<void> {
  const current = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
  if (!current?.body) {
    const loaded = await loadSkillWorkshopProposalDetail(state, context, proposalId);
    if (!loaded) {
      return;
    }
  }
  state.skillWorkshopSelectedKey = proposalId;
}

async function refreshAfterMutation(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  proposalId: string,
): Promise<void> {
  state.skillWorkshopLoaded = false;
  await loadSkillWorkshopProposals(state, context, { force: true });
  await loadSkillWorkshopProposalDetail(state, context, proposalId, { force: true });
}

export async function runSkillWorkshopLifecycleAction(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  action: Extract<SkillWorkshopAction, "apply" | "reject">,
  proposalId: string,
): Promise<void> {
  const method = action === "apply" ? "skills.proposals.apply" : "skills.proposals.reject";
  if (!canCallGatewayMethod(context.gateway.snapshot, method, "operator.admin")) {
    return;
  }
  const snapshot = context.gateway.snapshot;
  const client = snapshot.client;
  if (!client || snapshot.phase !== "connected" || state.skillWorkshopActionBusy) {
    return;
  }
  const previous = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
  state.skillWorkshopActionBusy = { key: proposalId, action };
  state.skillWorkshopActionNotice = null;
  state.skillWorkshopError = null;
  try {
    const requestParams = { ...loadedSkillWorkshopAgentParams(state, context), proposalId };
    await client.request(method, requestParams);
    await refreshAfterMutation(state, context, proposalId);
    const updated = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
    showActionNotice(
      state,
      updated ?? previous,
      t(action === "apply" ? "skillWorkshop.notices.applied" : "skillWorkshop.notices.rejected"),
    );
  } catch (err) {
    state.skillWorkshopError = formatUiError(err);
  } finally {
    if (
      state.skillWorkshopActionBusy?.key === proposalId &&
      state.skillWorkshopActionBusy.action === action
    ) {
      state.skillWorkshopActionBusy = null;
    }
  }
}

export async function runSkillWorkshopEvaluation(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  proposalId: string,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (
    !canCallGatewayMethod(context.gateway.snapshot, "skills.proposals.evaluate", "operator.admin")
  ) {
    return false;
  }
  const snapshot = context.gateway.snapshot;
  const client = snapshot.client;
  if (!client || snapshot.phase !== "connected" || state.skillWorkshopActionBusy) {
    return false;
  }
  const previous = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
  if (!previous || previous.status !== "pending") {
    return false;
  }
  const requestAgentId = loadedSkillWorkshopAgentParams(state, context).agentId;
  if (state.skillWorkshopAgentId === null) {
    state.skillWorkshopAgentId = requestAgentId;
  }
  state.skillWorkshopActionBusy = { key: proposalId, action: "evaluate" };
  state.skillWorkshopActionNotice = null;
  state.skillWorkshopError = null;
  try {
    const loaded = await loadSkillWorkshopProposalDetail(state, context, proposalId, {
      force: true,
    });
    if (
      !loaded ||
      !isCurrent() ||
      state.skillWorkshopAgentId !== requestAgentId ||
      !canCallGatewayMethod(context.gateway.snapshot, "skills.proposals.evaluate", "operator.admin")
    ) {
      return false;
    }
    const current = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
    if (!current || current.status !== "pending" || !current.revisionHash) {
      throw new Error(t("skillWorkshop.evaluation.errors.revisionHashUnavailable"));
    }
    const result = await client.request<SkillProposalEvaluateResult>("skills.proposals.evaluate", {
      agentId: requestAgentId,
      proposalId,
      expectedRevisionHash: current.revisionHash,
    });
    if (!isCurrent() || state.skillWorkshopAgentId !== requestAgentId) {
      return false;
    }
    if (result.evaluation.revisionHash !== current.revisionHash) {
      throw new Error(t("skillWorkshop.evaluation.errors.revisionChanged"));
    }
    mergeProposal(state, proposalFromEvaluation(result, current));
    await loadSkillWorkshopProposalDetail(state, context, proposalId, { force: true });
    showActionNotice(
      state,
      state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId) ?? previous,
      t("skillWorkshop.actions.evaluated"),
    );
    return true;
  } catch (err) {
    if (state.skillWorkshopAgentId === requestAgentId) {
      state.skillWorkshopError = formatUiError(err);
    }
    return false;
  } finally {
    if (
      state.skillWorkshopActionBusy?.key === proposalId &&
      state.skillWorkshopActionBusy.action === "evaluate"
    ) {
      state.skillWorkshopActionBusy = null;
    }
  }
}

export async function requestSkillWorkshopRevision(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  proposalId: string,
  sendRevisionRequest: (
    instructions: string,
    proposal: SkillWorkshopProposal,
    agentId: string,
  ) => Promise<void>,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (
    !canCallGatewayMethod(
      context.gateway.snapshot,
      "skills.proposals.requestRevision",
      "operator.admin",
    )
  ) {
    return false;
  }
  if (state.skillWorkshopActionBusy) {
    return false;
  }
  const proposal = state.skillWorkshopProposals.find((item) => item.key === proposalId);
  const instructions = state.skillWorkshopRevisionDraft.trim();
  if (!proposal || !instructions) {
    return false;
  }
  const proposalAgentId = loadedSkillWorkshopAgentParams(state, context).agentId;
  if (state.skillWorkshopAgentId === null) {
    state.skillWorkshopAgentId = proposalAgentId;
  }
  state.skillWorkshopActionBusy = { key: proposalId, action: "revise" };
  state.skillWorkshopActionNotice = null;
  state.skillWorkshopError = null;
  try {
    await loadSkillWorkshopProposalDetail(state, context, proposalId);
    if (
      !isCurrent() ||
      state.skillWorkshopAgentId !== proposalAgentId ||
      !canCallGatewayMethod(
        context.gateway.snapshot,
        "skills.proposals.requestRevision",
        "operator.admin",
      )
    ) {
      return false;
    }
    const currentProposal =
      state.skillWorkshopProposals.find((item) => item.key === proposalId) ?? proposal;
    await sendRevisionRequest(instructions, currentProposal, proposalAgentId);
    state.skillWorkshopRevisionKey = null;
    state.skillWorkshopRevisionDraft = "";
    showActionNotice(state, proposal, t("skillWorkshop.notices.revisionRequested"));
    return true;
  } catch (err) {
    state.skillWorkshopError = formatUiError(err);
    return false;
  } finally {
    if (
      state.skillWorkshopActionBusy?.key === proposalId &&
      state.skillWorkshopActionBusy.action === "revise"
    ) {
      state.skillWorkshopActionBusy = null;
    }
  }
}
