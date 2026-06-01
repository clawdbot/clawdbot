import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  SkillWorkshopAction,
  SkillWorkshopActionNotice,
  SkillWorkshopProposal,
} from "../views/skill-workshop.ts";

const SKILL_WORKSHOP_NOTICE_MS = 2800;

type SkillProposalStatus = "pending" | "applied" | "rejected" | "quarantined" | "stale";
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

export type SkillWorkshopState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  skillWorkshopLoading: boolean;
  skillWorkshopLoaded: boolean;
  skillWorkshopError: string | null;
  skillWorkshopInspectingKey: string | null;
  skillWorkshopProposals: SkillWorkshopProposal[];
  skillWorkshopSelectedKey: string | null;
  skillWorkshopActionBusy: { key: string; action: SkillWorkshopAction } | null;
  skillWorkshopActionNotice: SkillWorkshopActionNotice | null;
  skillWorkshopActionNoticeTimer?: ReturnType<typeof globalThis.setTimeout> | number | null;
  skillWorkshopRevisionKey: string | null;
  skillWorkshopRevisionDraft: string;
};

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
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
  options?: { force?: boolean },
): Promise<void> {
  if (!state.client || !state.connected || state.skillWorkshopLoading) {
    return;
  }
  if (state.skillWorkshopLoaded && !options?.force) {
    return;
  }
  state.skillWorkshopLoading = true;
  state.skillWorkshopError = null;
  try {
    const result = await state.client.request<SkillProposalManifest>("skills.proposals.list", {});
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
      await loadSkillWorkshopProposalDetail(state, state.skillWorkshopSelectedKey);
    }
  } catch (err) {
    state.skillWorkshopError = getErrorMessage(err);
  } finally {
    state.skillWorkshopLoading = false;
  }
}

export async function loadSkillWorkshopProposalDetail(
  state: SkillWorkshopState,
  proposalId: string,
  options?: { force?: boolean },
): Promise<void> {
  if (!state.client || !state.connected || state.skillWorkshopInspectingKey === proposalId) {
    return;
  }
  const existing = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
  if (existing?.body && !options?.force) {
    return;
  }
  state.skillWorkshopInspectingKey = proposalId;
  state.skillWorkshopError = null;
  try {
    const result = await state.client.request<SkillProposalInspectResult>(
      "skills.proposals.inspect",
      {
        proposalId,
      },
    );
    mergeProposal(state, proposalFromInspect(result, existing));
  } catch (err) {
    state.skillWorkshopError = getErrorMessage(err);
  } finally {
    if (state.skillWorkshopInspectingKey === proposalId) {
      state.skillWorkshopInspectingKey = null;
    }
  }
}

export function selectSkillWorkshopProposal(state: SkillWorkshopState, proposalId: string): void {
  state.skillWorkshopSelectedKey = proposalId;
  void loadSkillWorkshopProposalDetail(state, proposalId);
}

async function refreshAfterMutation(state: SkillWorkshopState, proposalId: string): Promise<void> {
  state.skillWorkshopLoaded = false;
  await loadSkillWorkshopProposals(state, { force: true });
  await loadSkillWorkshopProposalDetail(state, proposalId, { force: true });
}

export async function runSkillWorkshopLifecycleAction(
  state: SkillWorkshopState,
  action: Extract<SkillWorkshopAction, "apply" | "reject">,
  proposalId: string,
): Promise<void> {
  if (!state.client || !state.connected || state.skillWorkshopActionBusy) {
    return;
  }
  const previous = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
  state.skillWorkshopActionBusy = { key: proposalId, action };
  state.skillWorkshopActionNotice = null;
  state.skillWorkshopError = null;
  try {
    const method = action === "apply" ? "skills.proposals.apply" : "skills.proposals.reject";
    await state.client.request(method, { proposalId });
    await refreshAfterMutation(state, proposalId);
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

function buildRevisionRequest(proposal: SkillWorkshopProposal, instructions: string): string {
  return [
    `Revise Skill Workshop proposal \`${proposal.key}\` (${proposal.slug}).`,
    "",
    "Use `skill_workshop` with `action=inspect` first, then `action=revise` for that pending proposal.",
    "Do not apply, approve, reject, or install the proposal.",
    "",
    "Requested changes:",
    instructions.trim(),
  ].join("\n");
}

export async function requestSkillWorkshopRevision(
  state: SkillWorkshopState,
  proposalId: string,
  sendRevisionRequest: (message: string, proposal: SkillWorkshopProposal) => Promise<void>,
): Promise<boolean> {
  if (state.skillWorkshopActionBusy) {
    return false;
  }
  const proposal = state.skillWorkshopProposals.find((item) => item.key === proposalId);
  const instructions = state.skillWorkshopRevisionDraft.trim();
  if (!proposal || !instructions) {
    return false;
  }
  state.skillWorkshopActionBusy = { key: proposalId, action: "revise" };
  state.skillWorkshopActionNotice = null;
  state.skillWorkshopError = null;
  try {
    await loadSkillWorkshopProposalDetail(state, proposalId);
    const currentProposal =
      state.skillWorkshopProposals.find((item) => item.key === proposalId) ?? proposal;
    await sendRevisionRequest(buildRevisionRequest(currentProposal, instructions), currentProposal);
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
