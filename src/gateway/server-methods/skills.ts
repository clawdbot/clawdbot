// Gateway RPC handlers for skill discovery, install/update, and proposal workflows.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  buildClawHubTrustErrorDetails,
  ErrorCodes,
  errorShape,
  validateSkillsBinsParams,
  validateSkillsCuratorActionParams,
  validateSkillsCuratorStatusParams,
  validateSkillsDetailParams,
  validateSkillsInstallParams,
  validateSkillsProposalActionParams,
  validateSkillsProposalCreateParams,
  validateSkillsProposalDecisionParams,
  validateSkillsProposalEvaluateParams,
  validateSkillsProposalEventsListParams,
  validateSkillsProposalInspectParams,
  validateSkillsProposalRequestRevisionParams,
  validateSkillsProposalReviseParams,
  validateSkillsProposalsListParams,
  validateSkillsProposalUpdateParams,
  validateSkillsSearchParams,
  validateSkillsSecurityVerdictsParams,
  validateSkillsSkillCardParams,
  validateSkillsStatusParams,
  validateSkillsUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SkillLibrarySelection } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  tryResolveAmbientOwnerAgentId,
} from "../../agents/agent-scope-config.js";
import { resolveNodeExecEligibility } from "../../agents/exec-defaults.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import { fetchClawHubSkillDetail } from "../../infra/clawhub-skills.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { getOrCreatePromise } from "../../shared/lazy-promise.js";
import { updateSkillConfigEntry } from "../../skills/config/mutations.js";
import { collectSkillBins } from "../../skills/discovery/bins.js";
import { buildWorkspaceSkillStatus } from "../../skills/discovery/status.js";
import { loadSkillLibrarySelection } from "../../skills/library/selection.js";
import { parseRequestedClawHubSkillRef } from "../../skills/lifecycle/clawhub-store.js";
import {
  installSkillFromClawHub,
  readLocalSkillCardContentSync,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} from "../../skills/lifecycle/clawhub.js";
import { installSkill } from "../../skills/lifecycle/install.js";
import { installUploadedSkillArchive } from "../../skills/lifecycle/upload-install.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import {
  collectClawHubVerdictTargets,
  fetchOpenClawSkillSecurityVerdicts,
} from "../../skills/security/clawhub-verdicts.js";
import {
  getSkillCuratorStatus,
  SKILL_LIFECYCLE_CURATION_RETIRED_MESSAGE,
} from "../../skills/workshop/curator.js";
import { resolveSkillProposalName } from "../../skills/workshop/frontmatter.js";
import { assertExpectedRevisionHash } from "../../skills/workshop/service-evaluation.js";
import {
  applySkillProposal,
  evaluateSkillProposal,
  inspectSkillProposal,
  listSkillProposalEvents,
  listSkillProposals,
  proposeCreateSkill,
  proposeUpdateSkill,
  quarantineSkillProposal,
  rejectSkillProposal,
  reviseSkillProposal,
} from "../../skills/workshop/service.js";
import { PROPOSAL_DRAFT_FILE } from "../../skills/workshop/store-record.js";
import type { SkillProposalReadResult, SkillProposalRecord } from "../../skills/workshop/types.js";
import { authorizeSessionSharingTarget, resolveSessionSharingTarget } from "../session-sharing.js";
import { skillsLibraryHandlers } from "./skills-library.js";
import { skillProposalHistoryHandlers } from "./skills-proposal-history.js";
import { skillsUploadHandlers } from "./skills-upload.js";
import {
  resolveSkillsAgentWorkspace,
  runSkillsProposalWorkspaceHandler,
  SKILL_PROPOSAL_RESPONSE_HANDLED,
  type ResolvedSkillsWorkspace,
} from "./skills-workspace-handler.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

type ClawHubInstallResult = Awaited<ReturnType<typeof installSkillFromClawHub>>;
type ClawHubInstallParams = Parameters<typeof installSkillFromClawHub>[0];

const clawHubInstallsInFlight = new Map<string, Promise<ClawHubInstallResult>>();

function projectGatewaySkillProposalRecord(record: SkillProposalRecord): SkillProposalRecord {
  return record.draftFile === PROPOSAL_DRAFT_FILE
    ? record
    : { ...record, draftFile: PROPOSAL_DRAFT_FILE };
}

function projectGatewaySkillProposalResult<T extends { record: SkillProposalRecord }>(result: T) {
  return { ...result, record: projectGatewaySkillProposalRecord(result.record) };
}

function projectGatewaySkillProposalReadResult(proposal: SkillProposalReadResult) {
  return {
    ...projectGatewaySkillProposalResult(proposal),
    ...(proposal.supportFiles
      ? {
          supportFiles: proposal.supportFiles.map(({ path, content }) => ({ path, content })),
        }
      : {}),
  };
}

function installClawHubSkillDeduped(params: ClawHubInstallParams): Promise<ClawHubInstallResult> {
  // A WebSocket can disappear after the request reached the Gateway. Keep one
  // exact install per workspace in flight so a reconnect can safely reattach.
  const key = JSON.stringify([
    params.workspaceDir,
    params.slug,
    params.version ?? null,
    params.force ?? false,
  ]);
  return getOrCreatePromise(clawHubInstallsInFlight, key, () => installSkillFromClawHub(params), {
    evictOnSettled: true,
  });
}

function buildRemoteAwareWorkspaceSkillStatus(
  resolved: ResolvedSkillsWorkspace,
  selections?: SkillLibrarySelection[],
) {
  // Remote skill availability depends on the agent's executable-node surface,
  // not only the workspace contents, so status reports include live eligibility.
  const nodeSkills = resolveNodeExecEligibility({
    cfg: resolved.cfg,
    agentId: resolved.agentId,
  });
  return buildWorkspaceSkillStatus(resolved.workspaceDir, {
    ...(selections?.length
      ? {
          entries: [
            ...loadWorkspaceSkills(resolved.workspaceDir, {
              config: resolved.cfg,
              agentId: resolved.agentId,
              agentSkillFilter: "ignore",
            }),
            ...loadSkillLibrarySelection(selections),
          ],
        }
      : {}),
    config: resolved.cfg,
    agentId: resolved.agentId,
    eligibility: {
      nodeSkills,
      remote: getRemoteSkillEligibility({ advertiseExecNode: nodeSkills.canExec }),
    },
  });
}

function respondSkillWorkshopError(respond: RespondFn, err: unknown) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(err)));
}

function respondRetiredSkillCuratorAction(
  { params, respond }: GatewayRequestHandlerOptions,
  method: `skills.curator.${"pin" | "restore" | "unpin"}`,
): void {
  if (!assertValidParams(params, validateSkillsCuratorActionParams, method, respond)) {
    return;
  }
  respondSkillWorkshopError(respond, new Error(SKILL_LIFECYCLE_CURATION_RETIRED_MESSAGE));
}

function collectClawHubTrustWarnings(results: Array<{ warning?: string }>): string[] {
  return results
    .map((result) => normalizeOptionalString(result.warning))
    .filter((warning): warning is string => Boolean(warning));
}

function buildRevisionAgentInstruction(proposal: SkillProposalReadResult) {
  return [
    `Revise Skill Workshop proposal \`${proposal.record.id}\` (${resolveSkillProposalName(proposal.record.kind, proposal.record.target)}).`,
    "",
    "Use `skill_workshop` with `action=inspect` first, then `action=revise` for that pending proposal.",
    "The proposal ID and expected revision hash are bound by this run; do not substitute them.",
    "Do not apply, approve, reject, quarantine, or install the proposal.",
    "",
    "Requested changes:",
  ].join("\n");
}

async function forwardSkillWorkshopRevisionToChatSend(
  opts: GatewayRequestHandlerOptions,
  params: {
    agentId: string;
    idempotencyKey: string;
    instructions: string;
    proposal: NonNullable<Awaited<ReturnType<typeof inspectSkillProposal>>>;
    expectedRevisionHash: string;
    workspaceDir: string;
    sessionId?: string;
    sessionKey: string;
    targetAgentId?: string;
  },
): Promise<void> {
  const { handleChatSendWithSkillWorkshopProposalRevision } =
    await import("./chat-send-handler.js");
  const chatParams = {
    sessionKey: params.sessionKey,
    agentId: params.targetAgentId ?? params.agentId,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    message: params.instructions,
    deliver: false,
    queueMode: "followup" as const,
    systemProvenanceReceipt: buildRevisionAgentInstruction(params.proposal),
    suppressCommandInterpretation: true,
    idempotencyKey: params.idempotencyKey,
  };
  await handleChatSendWithSkillWorkshopProposalRevision(
    {
      ...opts,
      req: { ...opts.req, method: "chat.send", params: chatParams },
      params: chatParams,
    },
    {
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      proposalId: params.proposal.record.id,
      expectedRevisionHash: params.expectedRevisionHash,
    },
  );
}

/** Gateway request handlers for skill status, catalogs, installs, updates, and workshop proposals. */
export const skillsHandlers: GatewayRequestHandlers = {
  ...skillsLibraryHandlers,
  ...skillsUploadHandlers,
  ...skillProposalHistoryHandlers,
  "skills.status": ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateSkillsStatusParams, "skills.status", respond)) {
      return;
    }
    const agentId = params.agentId ?? tryResolveAmbientOwnerAgentId(context.getRuntimeConfig());
    const resolved = resolveSkillsAgentWorkspace({ ...params, agentId }, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    const target = params.sessionKey
      ? resolveSessionSharingTarget({
          cfg: resolved.cfg,
          sessionKey: params.sessionKey,
          agentId: resolved.agentId,
        })
      : undefined;
    if (params.sessionKey && !target) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Session not found."));
      return;
    }
    if (target) {
      const denied = authorizeSessionSharingTarget({ cfg: resolved.cfg, client, target });
      if (denied) {
        respond(false, undefined, denied);
        return;
      }
    }
    const report = buildRemoteAwareWorkspaceSkillStatus(
      resolved,
      target?.entry.skillLibrarySelections,
    );
    respond(true, report, undefined);
  },
  "skills.securityVerdicts": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSkillsSecurityVerdictsParams,
        "skills.securityVerdicts",
        respond,
      )
    ) {
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    try {
      const report = buildRemoteAwareWorkspaceSkillStatus(resolved);
      const targets = collectClawHubVerdictTargets(report);
      if (targets.length === 0) {
        respond(true, { schema: "openclaw.skills.security-verdicts.v1", items: [] }, undefined);
        return;
      }
      const items = await fetchOpenClawSkillSecurityVerdicts(targets);
      respond(true, { schema: "openclaw.skills.security-verdicts.v1", items }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
  "skills.skillCard": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsSkillCardParams, "skills.skillCard", respond)) {
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    const report = buildWorkspaceSkillStatus(resolved.workspaceDir, {
      config: resolved.cfg,
      agentId: resolved.agentId,
    });
    const skill = report.skills.find((candidate) => candidate.skillKey === params.skillKey);
    if (!skill?.skillCard) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `skill card not found for ${params.skillKey}`),
      );
      return;
    }
    const content = readLocalSkillCardContentSync(skill.baseDir);
    if (content === undefined) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `skill card not readable for ${params.skillKey}`),
      );
      return;
    }
    respond(
      true,
      {
        schema: "openclaw.skills.skill-card.v1",
        skillKey: skill.skillKey,
        path: skill.skillCard.path,
        sizeBytes: skill.skillCard.sizeBytes,
        content,
      },
      undefined,
    );
  },
  "skills.bins": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsBinsParams, "skills.bins", respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const bins = new Set<string>();
    for (const agentId of listAgentIds(cfg)) {
      // Node inventories include missing requirements, not only locally usable skills.
      const entries = loadWorkspaceSkills(resolveAgentWorkspaceDir(cfg, agentId), {
        config: cfg,
        agentId,
        agentSkillFilter: "ignore",
      });
      for (const bin of collectSkillBins(entries)) {
        bins.add(bin);
      }
    }
    respond(true, { bins: [...bins].toSorted() }, undefined);
  },
  "skills.search": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSkillsSearchParams, "skills.search", respond)) {
      return;
    }
    try {
      const results = await searchSkillsFromClawHub({
        query: (params as { query?: string }).query,
        limit: (params as { limit?: number }).limit,
      });
      respond(true, { results }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
  "skills.detail": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSkillsDetailParams, "skills.detail", respond)) {
      return;
    }
    try {
      // Same reference grammar as skills.install, so a client cannot review one publisher's
      // card and then install another's.
      const requested = parseRequestedClawHubSkillRef((params as { slug: string }).slug);
      if (requested.requestedReference) {
        // ClawHub has no source-qualified read endpoint, so reading this by bare slug would
        // show a same-slug registry skill while install resolves the external artifact.
        // Refusing keeps review and install on one identity until that contract exists.
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `ClawHub cannot return details for ${requested.requestedReference}; external skill sources are install-only. Install it directly, or run "openclaw skills install ${requested.requestedReference}".`,
          ),
        );
        return;
      }
      const detail = await fetchClawHubSkillDetail({
        slug: requested.slug,
        ...(requested.ownerHandle ? { ownerHandle: requested.ownerHandle } : {}),
      });
      respond(true, detail, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
  "skills.curator.status": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSkillsCuratorStatusParams,
        "skills.curator.status",
        respond,
      )
    ) {
      return;
    }
    respond(true, getSkillCuratorStatus(), undefined);
  },
  "skills.curator.pin": (options) =>
    respondRetiredSkillCuratorAction(options, "skills.curator.pin"),
  "skills.curator.unpin": (options) =>
    respondRetiredSkillCuratorAction(options, "skills.curator.unpin"),
  "skills.curator.restore": (options) =>
    respondRetiredSkillCuratorAction(options, "skills.curator.restore"),
  "skills.proposals.list": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.list",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalsListParams,
      run: (_parsedParams, resolved) =>
        listSkillProposals({ config: resolved.cfg, agentId: resolved.agentId }),
    });
  },
  "skills.proposals.events.list": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.events.list",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalEventsListParams,
      run: async (parsedParams, resolved) =>
        listSkillProposalEvents({
          agentId: resolved.agentId,
          config: resolved.cfg,
          proposalId: parsedParams.proposalId,
          afterSequence: parsedParams.afterSequence,
          limit: parsedParams.limit,
        }),
    });
  },
  "skills.proposals.inspect": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.inspect",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalInspectParams,
      run: async (parsedParams, resolved) => {
        const proposal = await inspectSkillProposal(parsedParams.proposalId, {
          agentId: resolved.agentId,
          config: resolved.cfg,
        });
        if (!proposal) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Skill proposal not found: ${parsedParams.proposalId}`,
            ),
          );
          return SKILL_PROPOSAL_RESPONSE_HANDLED;
        }
        return projectGatewaySkillProposalReadResult(proposal);
      },
    });
  },
  "skills.proposals.evaluate": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.evaluate",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalEvaluateParams,
      run: (parsedParams, resolved) =>
        evaluateSkillProposal({
          workspaceDir: resolved.workspaceDir,
          agentId: resolved.agentId,
          eventActor: { type: "gateway" },
          config: resolved.cfg,
          proposalId: parsedParams.proposalId,
          expectedRevisionHash: parsedParams.expectedRevisionHash,
          correlationId: parsedParams.correlationId,
          trigger: "manual",
        }).then(projectGatewaySkillProposalResult),
    });
  },
  "skills.proposals.create": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.create",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalCreateParams,
      run: (parsedParams, resolved) =>
        proposeCreateSkill({
          workspaceDir: resolved.workspaceDir,
          agentId: resolved.agentId,
          eventActor: { type: "gateway" },
          config: resolved.cfg,
          name: parsedParams.name,
          description: parsedParams.description,
          content: parsedParams.content,
          supportFiles: parsedParams.supportFiles,
          createdBy: "gateway",
          goal: parsedParams.goal,
          evidence: parsedParams.evidence,
        }).then(projectGatewaySkillProposalReadResult),
    });
  },
  "skills.proposals.update": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.update",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalUpdateParams,
      run: (parsedParams, resolved) =>
        proposeUpdateSkill({
          workspaceDir: resolved.workspaceDir,
          config: resolved.cfg,
          agentId: resolved.agentId,
          eventActor: { type: "gateway" },
          skillName: parsedParams.skillName,
          description: parsedParams.description,
          content: parsedParams.content,
          supportFiles: parsedParams.supportFiles,
          createdBy: "gateway",
          goal: parsedParams.goal,
          evidence: parsedParams.evidence,
        }).then(projectGatewaySkillProposalReadResult),
    });
  },
  "skills.proposals.revise": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.revise",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalReviseParams,
      run: (parsedParams, resolved) =>
        reviseSkillProposal({
          workspaceDir: resolved.workspaceDir,
          agentId: resolved.agentId,
          eventActor: { type: "gateway" },
          config: resolved.cfg,
          proposalId: parsedParams.proposalId,
          expectedRevisionHash: parsedParams.expectedRevisionHash,
          correlationId: parsedParams.correlationId,
          content: parsedParams.content,
          supportFiles: parsedParams.supportFiles,
          description: parsedParams.description,
          goal: parsedParams.goal,
          evidence: parsedParams.evidence,
        }).then(projectGatewaySkillProposalReadResult),
    });
  },
  "skills.proposals.requestRevision": async (opts) => {
    const { params, respond, context } = opts;
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.requestRevision",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalRequestRevisionParams,
      run: async (parsedParams, resolved) => {
        const expectedRevisionHash = parsedParams.expectedRevisionHash;
        const proposal = await inspectSkillProposal(parsedParams.proposalId, {
          agentId: resolved.agentId,
          config: resolved.cfg,
        });
        if (!proposal) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Skill proposal not found: ${parsedParams.proposalId}`,
            ),
          );
          return SKILL_PROPOSAL_RESPONSE_HANDLED;
        }
        if (proposal.record.status !== "pending") {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Skill proposal is not pending: ${parsedParams.proposalId}`,
            ),
          );
          return SKILL_PROPOSAL_RESPONSE_HANDLED;
        }
        assertExpectedRevisionHash(proposal.revisionHash, expectedRevisionHash);
        await forwardSkillWorkshopRevisionToChatSend(opts, {
          agentId: resolved.agentId,
          expectedRevisionHash,
          idempotencyKey: parsedParams.idempotencyKey,
          instructions: parsedParams.instructions,
          proposal,
          workspaceDir: resolved.workspaceDir,
          sessionId: parsedParams.sessionId,
          sessionKey: parsedParams.sessionKey,
          targetAgentId: parsedParams.targetAgentId
            ? normalizeAgentId(parsedParams.targetAgentId)
            : undefined,
        });
        return SKILL_PROPOSAL_RESPONSE_HANDLED;
      },
    });
  },
  "skills.proposals.apply": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.apply",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalDecisionParams,
      run: (parsedParams, resolved) =>
        applySkillProposal({
          workspaceDir: resolved.workspaceDir,
          agentId: resolved.agentId,
          eventActor: { type: "gateway" },
          config: resolved.cfg,
          proposalId: parsedParams.proposalId,
          expectedRevisionHash: parsedParams.expectedRevisionHash,
          correlationId: parsedParams.correlationId,
          reason: parsedParams.reason,
        }).then(projectGatewaySkillProposalResult),
    });
  },
  "skills.proposals.reject": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.reject",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalDecisionParams,
      run: (parsedParams, resolved) =>
        rejectSkillProposal({
          workspaceDir: resolved.workspaceDir,
          agentId: resolved.agentId,
          eventActor: { type: "gateway" },
          config: resolved.cfg,
          proposalId: parsedParams.proposalId,
          expectedRevisionHash: parsedParams.expectedRevisionHash,
          correlationId: parsedParams.correlationId,
          reason: parsedParams.reason,
        }).then(projectGatewaySkillProposalRecord),
    });
  },
  "skills.proposals.quarantine": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.quarantine",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalActionParams,
      run: (parsedParams, resolved) =>
        quarantineSkillProposal({
          workspaceDir: resolved.workspaceDir,
          agentId: resolved.agentId,
          eventActor: { type: "gateway" },
          config: resolved.cfg,
          proposalId: parsedParams.proposalId,
          expectedRevisionHash: parsedParams.expectedRevisionHash,
          correlationId: parsedParams.correlationId,
          reason: parsedParams.reason,
        }).then(projectGatewaySkillProposalRecord),
    });
  },
  "skills.install": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsInstallParams, "skills.install", respond)) {
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    const cfg = resolved.cfg;
    const workspaceDirRaw = resolved.workspaceDir;
    // Skill installs are intentionally routed by source; each source owns its
    // validation, provenance checks, and result payload shape.
    if (params && typeof params === "object" && "source" in params && params.source === "clawhub") {
      const p = params as {
        source: "clawhub";
        slug: string;
        version?: string;
        force?: boolean;
      };
      const result = await installClawHubSkillDeduped({
        workspaceDir: workspaceDirRaw,
        slug: p.slug,
        version: p.version,
        force: Boolean(p.force),
        logger: context.logGateway,
        config: cfg,
      });
      const errorDetails = result.ok ? undefined : buildClawHubTrustErrorDetails(result);
      respond(
        result.ok,
        result.ok
          ? {
              ok: true,
              message: `Installed ${result.slug}@${result.version}`,
              stdout: "",
              stderr: "",
              code: 0,
              slug: result.slug,
              version: result.version,
              targetDir: result.targetDir,
              ...(result.warning ? { warning: result.warning } : {}),
            }
          : result,
        result.ok
          ? undefined
          : errorShape(
              ErrorCodes.UNAVAILABLE,
              result.error,
              errorDetails ? { details: errorDetails } : undefined,
            ),
      );
      return;
    }
    if (params && typeof params === "object" && "source" in params && params.source === "upload") {
      const p = params as {
        source: "upload";
        uploadId: string;
        slug: string;
        force?: boolean;
        sha256?: string;
        timeoutMs?: number;
      };
      const result = await installUploadedSkillArchive({
        uploadId: p.uploadId,
        slug: p.slug,
        force: Boolean(p.force),
        sha256: p.sha256,
        timeoutMs: p.timeoutMs,
        workspaceDir: workspaceDirRaw,
        config: cfg,
        log: context.logGateway,
      });
      const errorCode =
        !result.ok && result.errorKind === "invalid-request"
          ? ErrorCodes.INVALID_REQUEST
          : ErrorCodes.UNAVAILABLE;
      const responseResult = result.ok
        ? result
        : {
            ok: false,
            error: result.error,
            errorCode,
          };
      respond(
        result.ok,
        responseResult,
        result.ok ? undefined : errorShape(errorCode, result.error),
      );
      return;
    }
    const p = params as {
      name: string;
      installId: string;
      timeoutMs?: number;
    };
    const result = await installSkill({
      workspaceDir: workspaceDirRaw,
      agentId: resolved.agentId,
      skillName: p.name,
      installId: p.installId,
      timeoutMs: p.timeoutMs,
      config: cfg,
    });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
    );
  },
  "skills.update": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsUpdateParams, "skills.update", respond)) {
      return;
    }
    if (params && typeof params === "object" && "source" in params && params.source === "clawhub") {
      const p = params as {
        source: "clawhub";
        slug?: string;
        all?: boolean;
        force?: boolean;
      };
      if (!p.slug && !p.all) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, 'clawhub skills.update requires "slug" or "all"'),
        );
        return;
      }
      if (p.slug && p.all) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            'clawhub skills.update accepts either "slug" or "all", not both',
          ),
        );
        return;
      }
      const resolved = resolveSkillsAgentWorkspace(params, context);
      if (!resolved.ok) {
        respond(false, undefined, resolved.error);
        return;
      }
      const results = await updateSkillsFromClawHub({
        workspaceDir: resolved.workspaceDir,
        slug: p.slug,
        ...(p.force ? { force: true } : {}),
        logger: context.logGateway,
        config: resolved.cfg,
      });
      const errors = results.filter((result) => !result.ok);
      const warnings = collectClawHubTrustWarnings(results);
      respond(
        errors.length === 0,
        {
          ok: errors.length === 0,
          skillKey: p.slug ?? "*",
          config: {
            source: "clawhub",
            results,
          },
        },
        errors.length === 0
          ? undefined
          : errorShape(ErrorCodes.UNAVAILABLE, errors.map((result) => result.error).join("; "), {
              details: {
                results,
                ...(warnings.length > 0 ? { warnings } : {}),
              },
            }),
      );
      return;
    }
    const p = params as {
      skillKey: string;
      enabled?: boolean;
      apiKey?: string;
      env?: Record<string, string>;
    };
    const updated = await updateSkillConfigEntry(p);
    respond(
      true,
      { ok: true, skillKey: p.skillKey, config: redactConfigObject(updated) },
      undefined,
    );
  },
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
