// Control UI controller manages skill workshop gateway state.
import { readSkillProposalRevisionChangedError } from "@openclaw/gateway-protocol";
import { stripFrontmatterBlock } from "../../../../packages/markdown-core/src/frontmatter.js";
import type { AgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationGateway } from "../../app/context.ts";
import type { SkillWorkshopRevisionAdmissionOutcome } from "../../app/skill-workshop-revision-admissions.ts";
import { t } from "../../i18n/index.ts";
import { computeLineDiff } from "../../lib/chat/tool-call-diff.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import {
  filterSkillWorkshopProposals,
  changedSkillWorkshopVersion,
  type SkillWorkshopAction,
  type SkillWorkshopInstalledSkill,
  type SkillWorkshopInstalledSelection,
  type SkillWorkshopProposal,
  type SkillWorkshopProposalDecision,
} from "../../lib/skill-workshop/index.ts";
import {
  parseDateMs,
  proposalFromEvaluation,
  proposalFromInspect,
  proposalFromManifest,
  type SkillProposalEvaluateResult,
  type SkillProposalInspectResult,
  type SkillProposalManifest,
} from "./proposal-records.ts";
import { createSkillWorkshopHistoryScanState, type SkillWorkshopState } from "./state.ts";
export {
  createSkillWorkshopState,
  skillWorkshopRouteData,
  type SkillWorkshopRouteData,
  type SkillWorkshopState,
} from "./state.ts";

const SKILL_WORKSHOP_NOTICE_MS = 2800;

export type SkillWorkshopContext = {
  gateway: ApplicationGateway;
  agentSelection: Pick<AgentSelectionCapability, "state">;
};

function skillWorkshopAgentParams(context: SkillWorkshopContext): { agentId: string } {
  const snapshot = context.gateway.snapshot;
  const sessionAgentId = parseAgentSessionKey(snapshot.sessionKey)?.agentId;
  const selectedAgentId = context.agentSelection.state.selectedId;
  return {
    agentId: selectedAgentId
      ? normalizeAgentId(selectedAgentId)
      : sessionAgentId
        ? normalizeAgentId(sessionAgentId)
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
  state.skillWorkshopInstalledSkills = [];
  state.skillWorkshopInstalledName = null;
  state.skillWorkshopSelectedKey = null;
  state.skillWorkshopInspectingKey = null;
  state.skillWorkshopRevisionKey = null;
  state.skillWorkshopRevisionDraft = "";
  state.skillWorkshopFilePreviewKey = null;
  state.skillWorkshopFilePreviewQuery = "";
  state.skillWorkshopHistoryScan = createSkillWorkshopHistoryScanState();
  inspectRequestsByState.delete(state);
  selectionRequestByState.delete(state);
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
  options?: { persistent?: boolean },
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
  if (options?.persistent) {
    return;
  }
  state.skillWorkshopActionNoticeTimer = globalThis.setTimeout(() => {
    if (state.skillWorkshopActionNotice?.key === proposal.key) {
      state.skillWorkshopActionNotice = null;
    }
    state.skillWorkshopActionNoticeTimer = null;
  }, SKILL_WORKSHOP_NOTICE_MS);
}

export async function selectSkillWorkshopInstalledSkill(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  name: string,
  options?: { force?: boolean },
): Promise<void> {
  const skill = state.skillWorkshopInstalledSkills.find((entry) => entry.name === name);
  if (!skill) {
    return;
  }
  state.skillWorkshopInstalledName = name;
  await loadInstalledSkill(state, context, skill, options);
}

async function loadInstalledSkill(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  skill: SkillWorkshopInstalledSkill,
  options?: { force?: boolean },
): Promise<void> {
  const { client, phase } = context.gateway.snapshot;
  const agentId = loadedSkillWorkshopAgentParams(state, context).agentId;
  if (!client || phase !== "connected" || (skill.read && !options?.force)) {
    return;
  }
  // Each inventory row owns its read. Replacing inventory or retrying revokes old results.
  const loading = { status: "loading", name: skill.name } as const;
  skill.read = loading;
  const read = await readSkillWorkshopInstalledSkill(
    client,
    agentId,
    skill.name,
    state.skillWorkshopProposals,
  );
  if (
    state.skillWorkshopInstalledSkills.includes(skill) &&
    skill.read === loading &&
    state.skillWorkshopAgentId === agentId &&
    skillWorkshopAgentParams(context).agentId === agentId &&
    context.gateway.snapshot.client === client
  ) {
    skill.read = read;
  }
}

async function readSkillWorkshopInstalledSkill(
  client: NonNullable<ApplicationGateway["snapshot"]["client"]>,
  agentId: string,
  name: string,
  proposals: SkillWorkshopProposal[],
): Promise<SkillWorkshopInstalledSelection> {
  try {
    const result = await client.request<SkillWorkshopInstalledSkill & { content: string }>(
      "skills.workshop.read",
      { agentId, name },
    );
    const saved = await Promise.allSettled(
      proposals
        .filter((proposal) => proposal.status === "applied" && proposal.slug === result.skillKey)
        .map((proposal) =>
          client.request<SkillProposalInspectResult>("skills.proposals.inspect", {
            agentId,
            proposalId: proposal.key,
          }),
        ),
    );
    let savedVersionsError: string | undefined;
    // Same-named workspace proposals are not versions of this agent's installed skill.
    // Only compare retained, applied Workshop bodies; never infer intermediate edits.
    const savedVersions = saved
      .flatMap((read) => {
        if (read.status === "rejected") {
          savedVersionsError = formatUiError(read.reason);
          return [];
        }
        const { record, content } = read.value;
        return record.status === "applied" &&
          record.target.source === "openclaw-workshop" &&
          record.target.skillKey === result.skillKey &&
          (record.kind === "create" ? record.target.skillKey : record.target.skillName) ===
            result.name
          ? [
              {
                key: record.id,
                appliedAt: record.appliedAt,
                // Draft headers include lifecycle fields that are not skill instructions.
                diff: computeLineDiff(
                  stripFrontmatterBlock(content),
                  stripFrontmatterBlock(result.content),
                  { compactUnchanged: true },
                ),
              },
            ]
          : [];
      })
      .toSorted((left, right) => (right.appliedAt ?? "").localeCompare(left.appliedAt ?? ""));
    return {
      status: "ready",
      name,
      content: result.content,
      savedVersions,
      savedVersionsError,
    };
  } catch (error) {
    return {
      status: "error",
      name,
      error: formatUiError(error),
    };
  }
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
    state.skillWorkshopInstalledSkills = result.installedSkills;
    if (!result.installedSkills.some((skill) => skill.name === state.skillWorkshopInstalledName)) {
      state.skillWorkshopInstalledName = null;
    }
    state.skillWorkshopLoaded = true;
    if (state.skillWorkshopMode === "skills") {
      const installed = state.skillWorkshopInstalledSkills;
      await Promise.all(installed.map((skill) => loadInstalledSkill(state, context, skill)));
      if (state.skillWorkshopInstalledSkills === installed) {
        state.skillWorkshopInstalledName ??=
          (installed.find((skill) => changedSkillWorkshopVersion(skill.read)) ?? installed[0])
            ?.name ?? null;
      }
      return;
    }
    const visibleProposals = filterSkillWorkshopProposals(proposals, state.skillWorkshopQuery);
    const selectedProposal = proposals.find(
      (proposal) => proposal.key === state.skillWorkshopSelectedKey,
    );
    if (!visibleProposals.some((proposal) => proposal.key === selectedProposal?.key)) {
      state.skillWorkshopSelectedKey = visibleProposals[0]?.key ?? null;
      // Only a refresh that actually reassigns the pane owns the selection
      // fence; otherwise a background reload would silence an in-flight click.
      if (state.skillWorkshopSelectedKey) {
        markSkillWorkshopSelectionRequest(state, state.skillWorkshopSelectedKey);
      }
    }
    const selectedKey = state.skillWorkshopSelectedKey;
    if (selectedKey) {
      // Route data retains the selection but not its ephemeral request fence.
      if (!selectionRequestByState.has(state)) {
        markSkillWorkshopSelectionRequest(state, selectedKey);
      }
      await loadSkillWorkshopProposalDetail(state, context, selectedKey);
    }
  } catch (err) {
    if (skillWorkshopAgentParams(context).agentId === requestAgentId) {
      state.skillWorkshopError = formatUiError(err);
    }
  } finally {
    state.skillWorkshopLoading = false;
    if (skillWorkshopAgentParams(context).agentId !== requestAgentId) {
      void loadSkillWorkshopProposals(state, context, { force: true });
    }
  }
}

type SkillWorkshopGatewayClient = NonNullable<ApplicationGateway["snapshot"]["client"]>;

// Rapid suggestion clicks overlap: each inspect awaits the Gateway, so a slower
// earlier request must neither re-issue the same call nor publish its selection
// or error after a newer click won the pane. Both fences are keyed on the live
// state object so nothing reaches the persisted route data.
const inspectRequestsByState = new WeakMap<SkillWorkshopState, Map<string, Promise<boolean>>>();
const selectionRequestByState = new WeakMap<SkillWorkshopState, string>();

function inspectRequests(state: SkillWorkshopState): Map<string, Promise<boolean>> {
  const existing = inspectRequestsByState.get(state);
  if (existing) {
    return existing;
  }
  const requests = new Map<string, Promise<boolean>>();
  inspectRequestsByState.set(state, requests);
  return requests;
}

function markSkillWorkshopSelectionRequest(state: SkillWorkshopState, proposalId: string): void {
  selectionRequestByState.set(state, proposalId);
}

function isLatestSkillWorkshopSelection(state: SkillWorkshopState, proposalId: string): boolean {
  return selectionRequestByState.get(state) === proposalId;
}

async function inspectSkillWorkshopProposal(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  client: SkillWorkshopGatewayClient,
  proposalId: string,
  existing: SkillWorkshopProposal | undefined,
): Promise<boolean> {
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
    if (state.skillWorkshopAgentId !== requestAgentId) {
      return false;
    }
    mergeProposal(state, proposalFromInspect(result, existing));
    return true;
  } catch (err) {
    // Only the revision the operator is waiting on may publish an error; a
    // superseded click stays quiet.
    if (
      state.skillWorkshopAgentId === requestAgentId &&
      isLatestSkillWorkshopSelection(state, proposalId)
    ) {
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

function loadSkillWorkshopProposalDetail(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  proposalId: string,
  options?: { force?: boolean },
): Promise<boolean> {
  const snapshot = context.gateway.snapshot;
  const client = snapshot.client;
  if (!client || snapshot.phase !== "connected") {
    return Promise.resolve(false);
  }
  const existing = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
  if (existing?.bodyLoaded && !options?.force) {
    return Promise.resolve(true);
  }
  const requests = inspectRequests(state);
  const inFlight = requests.get(proposalId);
  if (inFlight) {
    return inFlight;
  }
  const request = inspectSkillWorkshopProposal(
    state,
    context,
    client,
    proposalId,
    existing,
  ).finally(() => {
    if (requests.get(proposalId) === request) {
      requests.delete(proposalId);
    }
  });
  requests.set(proposalId, request);
  return request;
}

export async function selectSkillWorkshopProposal(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  proposalId: string,
): Promise<void> {
  markSkillWorkshopSelectionRequest(state, proposalId);
  const current = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
  if (!current?.bodyLoaded) {
    const loaded = await loadSkillWorkshopProposalDetail(state, context, proposalId);
    if (!loaded || !isLatestSkillWorkshopSelection(state, proposalId)) {
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

function markSkillWorkshopRevisionChanged(
  state: SkillWorkshopState,
  proposalId: string,
  fallback?: SkillWorkshopProposal,
): void {
  showActionNotice(
    state,
    state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId) ?? fallback,
    t("skillWorkshop.notices.proposalChanged"),
    { persistent: true },
  );
}

export async function runSkillWorkshopLifecycleAction(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  action: Extract<SkillWorkshopAction, "apply" | "reject">,
  decision: SkillWorkshopProposalDecision,
): Promise<void> {
  const { proposalId, expectedRevisionHash } = decision;
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
  if (!expectedRevisionHash) {
    clearActionNoticeTimer(state);
    state.skillWorkshopActionNotice = null;
    state.skillWorkshopError = t("skillWorkshop.evaluation.errors.revisionHashUnavailable");
    return;
  }
  state.skillWorkshopActionBusy = { key: proposalId, action };
  state.skillWorkshopActionNotice = null;
  state.skillWorkshopError = null;
  try {
    const requestParams = {
      ...loadedSkillWorkshopAgentParams(state, context),
      proposalId,
      expectedRevisionHash,
    };
    await client.request(method, requestParams);
    await refreshAfterMutation(state, context, proposalId);
    const updated = state.skillWorkshopProposals.find((proposal) => proposal.key === proposalId);
    showActionNotice(
      state,
      updated ?? previous,
      t(action === "apply" ? "skillWorkshop.notices.applied" : "skillWorkshop.notices.rejected"),
    );
  } catch (err) {
    if (readSkillProposalRevisionChangedError(err)) {
      await refreshAfterMutation(state, context, proposalId);
      markSkillWorkshopRevisionChanged(state, proposalId, previous);
    } else {
      state.skillWorkshopError = formatUiError(err);
    }
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
    expectedRevisionHash?: string,
  ) => Promise<SkillWorkshopRevisionAdmissionOutcome>,
  isCurrent: () => boolean = () => true,
): Promise<SkillWorkshopRevisionAdmissionOutcome | null> {
  if (
    !canCallGatewayMethod(
      context.gateway.snapshot,
      "skills.proposals.requestRevision",
      "operator.admin",
    )
  ) {
    return null;
  }
  if (state.skillWorkshopActionBusy) {
    return null;
  }
  const proposal = state.skillWorkshopProposals.find((item) => item.key === proposalId);
  const instructions = state.skillWorkshopRevisionDraft.trim();
  if (!proposal || !instructions) {
    return null;
  }
  const proposalAgentId = loadedSkillWorkshopAgentParams(state, context).agentId;
  if (state.skillWorkshopAgentId === null) {
    state.skillWorkshopAgentId = proposalAgentId;
  }
  state.skillWorkshopActionBusy = { key: proposalId, action: "revise" };
  state.skillWorkshopActionNotice = null;
  state.skillWorkshopError = null;
  try {
    if (
      !isCurrent() ||
      state.skillWorkshopAgentId !== proposalAgentId ||
      !canCallGatewayMethod(
        context.gateway.snapshot,
        "skills.proposals.requestRevision",
        "operator.admin",
      )
    ) {
      return null;
    }
    const currentProposal =
      state.skillWorkshopProposals.find((item) => item.key === proposalId) ?? proposal;
    const outcome = await sendRevisionRequest(
      instructions,
      currentProposal,
      proposalAgentId,
      currentProposal.revisionHash ?? undefined,
    );
    if (outcome.status === "revision-changed") {
      if (isCurrent() && state.skillWorkshopAgentId === proposalAgentId) {
        await refreshAfterMutation(state, context, proposalId);
        state.skillWorkshopRevisionKey = null;
        state.skillWorkshopRevisionDraft = "";
        markSkillWorkshopRevisionChanged(state, proposalId, proposal);
      }
      return outcome;
    }
    if (outcome.status === "retryable-failed") {
      if (isCurrent() && state.skillWorkshopAgentId === proposalAgentId) {
        state.skillWorkshopError = t("skillWorkshop.revision.notAdmitted", {
          error: outcome.error,
        });
      }
      return outcome;
    }
    if (!isCurrent() || state.skillWorkshopAgentId !== proposalAgentId) {
      return outcome;
    }
    state.skillWorkshopRevisionKey = null;
    state.skillWorkshopRevisionDraft = "";
    showActionNotice(state, proposal, t("skillWorkshop.notices.revisionRequested"));
    return outcome;
  } catch (err) {
    if (isCurrent()) {
      state.skillWorkshopError = t("skillWorkshop.revision.notAdmitted", {
        error: formatUiError(err),
      });
    }
    return null;
  } finally {
    if (
      state.skillWorkshopActionBusy?.key === proposalId &&
      state.skillWorkshopActionBusy.action === "revise"
    ) {
      state.skillWorkshopActionBusy = null;
    }
  }
}
