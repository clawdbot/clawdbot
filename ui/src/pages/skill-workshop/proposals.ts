// Control UI controller manages skill workshop gateway state.
import { formatByteSize } from "@openclaw/normalization-core";
import type { AgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationGateway } from "../../app/context.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import type {
  SkillWorkshopAction,
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
type SkillProposalKind = "create" | "update";
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
  content: string;
  supportFiles?: SkillProposalSupportFile[];
};

export type SkillWorkshopContext = {
  gateway: ApplicationGateway;
  agentSelection: Pick<AgentSelectionCapability, "state">;
};

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
  if (!value) {
    return Date.now();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "kilo",
    separator: " ",
    fractionDigits: (_value, unit) => (unit === "byte" ? null : 1),
  });
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
    size: formatBytes(sizes.get(file.path) ?? byteLength(file.content)),
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
    slug: entry.skillKey,
    name: entry.title || entry.skillName,
    oneLine: entry.description,
    body: previousIsCurrent ? previous.body : "",
    status: entry.status,
    ...(previousIsCurrent && previous.origin ? { origin: previous.origin } : {}),
    version: previousIsCurrent ? previous.version : 1,
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
  return {
    key: record.id,
    slug: record.target.skillKey,
    name: record.title || record.target.skillName,
    oneLine: record.description,
    body: stripProposalFrontmatter(result.content),
    status: record.status,
    ...(record.origin ? { origin: record.origin } : {}),
    version: proposedVersionNumber(record.proposedVersion),
    createdAt,
    updatedAt,
    recencyGroup: recencyGroup(updatedAt || createdAt),
    ageLabel: compactAgeLabel(updatedAt || createdAt),
    supportFiles: supportFilesFromInspect(result),
    isNew: previous?.isNew ?? false,
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
    state.skillWorkshopError = getErrorMessage(err);
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
      state.skillWorkshopError = getErrorMessage(err);
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
    const method = action === "apply" ? "skills.proposals.apply" : "skills.proposals.reject";
    const requestParams = { ...loadedSkillWorkshopAgentParams(state, context), proposalId };
    await client.request(method, requestParams);
    await refreshAfterMutation(state, context, proposalId);
    const updated = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
    showActionNotice(state, updated ?? previous, action === "apply" ? "Applied" : "Rejected");
  } catch (err) {
    state.skillWorkshopError = getErrorMessage(err);
  } finally {
    if (
      state.skillWorkshopActionBusy?.key === proposalId &&
      state.skillWorkshopActionBusy.action === action
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
): Promise<boolean> {
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
    if (state.skillWorkshopAgentId !== proposalAgentId) {
      return false;
    }
    const currentProposal =
      state.skillWorkshopProposals.find((item) => item.key === proposalId) ?? proposal;
    await sendRevisionRequest(instructions, currentProposal, proposalAgentId);
    state.skillWorkshopRevisionKey = null;
    state.skillWorkshopRevisionDraft = "";
    showActionNotice(state, proposal, "Revision requested");
    return true;
  } catch (err) {
    state.skillWorkshopError = getErrorMessage(err);
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
