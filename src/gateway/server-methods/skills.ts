// Gateway RPC handlers for skill discovery, install/update, and proposal workflows.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSkillsBinsParams,
  validateSkillsDetailParams,
  validateSkillsInstallParams,
  validateSkillsProposalActionParams,
  validateSkillsProposalCreateParams,
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
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { canExecRequestNode } from "../../agents/exec-defaults.js";
import { listAgentWorkspaceDirs } from "../../agents/workspace-dirs.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import { fetchClawHubSkillDetail } from "../../infra/clawhub.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { updateSkillConfigEntry } from "../../skills/config/mutations.js";
import { collectSkillBins } from "../../skills/discovery/bins.js";
import { buildWorkspaceSkillStatus } from "../../skills/discovery/status.js";
import {
  installSkillFromClawHub,
  readLocalSkillCardContentSync,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} from "../../skills/lifecycle/clawhub.js";
import { installSkill } from "../../skills/lifecycle/install.js";
import { installUploadedSkillArchive } from "../../skills/lifecycle/upload-install.js";
import { loadWorkspaceSkillEntries } from "../../skills/loading/workspace.js";
import { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import {
  collectClawHubVerdictTargets,
  fetchOpenClawSkillSecurityVerdicts,
} from "../../skills/security/clawhub-verdicts.js";
import {
  applySkillProposal,
  inspectSkillProposal,
  listSkillProposals,
  proposeCreateSkill,
  proposeUpdateSkill,
  quarantineSkillProposal,
  rejectSkillProposal,
  reviseSkillProposal,
} from "../../skills/workshop/service.js";
import { skillsUploadHandlers } from "./skills-upload.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

function resolveSkillsAgentWorkspace(params: unknown, context: GatewayRequestContext) {
  const cfg = context.getRuntimeConfig();
  const agentIdRaw =
    params && typeof params === "object" && "agentId" in params
      ? normalizeOptionalString((params as { agentId?: unknown }).agentId)
      : undefined;
  const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
  if (agentIdRaw) {
    // Explicit agent routing must name a configured agent; otherwise a typo
    // could create or inspect skills under an unintended workspace.
    const knownAgents = listAgentIds(cfg);
    if (!knownAgents.includes(agentId)) {
      return {
        ok: false as const,
        error: errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentIdRaw}"`),
      };
    }
  }
  return {
    ok: true as const,
    cfg,
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
  };
}

type ResolvedSkillsWorkspace = Extract<
  ReturnType<typeof resolveSkillsAgentWorkspace>,
  { ok: true }
>;

function buildRemoteAwareWorkspaceSkillStatus(resolved: ResolvedSkillsWorkspace) {
  // Remote skill availability depends on the agent's executable-node surface,
  // not only the workspace contents, so status reports include live eligibility.
  return buildWorkspaceSkillStatus(resolved.workspaceDir, {
    config: resolved.cfg,
    eligibility: {
      remote: getRemoteSkillEligibility({
        advertiseExecNode: canExecRequestNode({
          cfg: resolved.cfg,
          agentId: resolved.agentId,
        }),
      }),
    },
  });
}

function respondSkillWorkshopError(respond: RespondFn, err: unknown) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(err)));
}

function buildRevisionAgentInstruction(proposal: Awaited<ReturnType<typeof inspectSkillProposal>>) {
  if (!proposal) {
    return "";
  }
  return [
    `Revise Skill Workshop proposal \`${proposal.record.id}\` (${proposal.record.target.skillKey}).`,
    "",
    "Use `skill_workshop` with `action=inspect` first, then `action=revise` for that pending proposal.",
    "Do not apply, approve, reject, quarantine, or install the proposal.",
    "",
    "Requested changes:",
  ].join("\n");
}

const SKILL_PROPOSAL_RESPONSE_HANDLED = Symbol("skill proposal response handled");

async function runSkillsProposalWorkspaceHandler<TParams, TResult>(params: {
  method: string;
  rawParams: unknown;
  respond: RespondFn;
  context: GatewayRequestContext;
  validate: Validator<TParams>;
  run: (
    parsedParams: TParams,
    resolved: ResolvedSkillsWorkspace,
  ) => Promise<TResult | typeof SKILL_PROPOSAL_RESPONSE_HANDLED>;
}): Promise<void> {
  if (!assertValidParams(params.rawParams, params.validate, params.method, params.respond)) {
    return;
  }
  const resolved = resolveSkillsAgentWorkspace(params.rawParams, params.context);
  if (!resolved.ok) {
    params.respond(false, undefined, resolved.error);
    return;
  }
  try {
    const result = await params.run(params.rawParams, resolved);
    if (result !== SKILL_PROPOSAL_RESPONSE_HANDLED) {
      params.respond(true, result, undefined);
    }
  } catch (err) {
    respondSkillWorkshopError(params.respond, err);
  }
}

async function forwardSkillWorkshopRevisionToChatSend(
  opts: GatewayRequestHandlerOptions,
  params: {
    agentId: string;
    idempotencyKey: string;
    instructions: string;
    proposal: NonNullable<Awaited<ReturnType<typeof inspectSkillProposal>>>;
    sessionId?: string;
    sessionKey: string;
    targetAgentId?: string;
  },
): Promise<void> {
  const { chatHandlers } = await import("./chat.js");
  const chatSend = chatHandlers["chat.send"];
  if (!chatSend) {
    throw new Error("chat.send handler is unavailable");
  }
  const chatParams = {
    sessionKey: params.sessionKey,
    agentId: params.targetAgentId ?? params.agentId,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    message: params.instructions,
    deliver: false,
    systemProvenanceReceipt: buildRevisionAgentInstruction(params.proposal),
    suppressCommandInterpretation: true,
    idempotencyKey: params.idempotencyKey,
  };
  await chatSend({
    ...opts,
    req: { ...opts.req, method: "chat.send", params: chatParams },
    params: chatParams,
  });
}

/** Gateway request handlers for skill status, catalogs, installs, updates, and workshop proposals. */
export const skillsHandlers: GatewayRequestHandlers = {
  ...skillsUploadHandlers,
  "skills.status": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsStatusParams, "skills.status", respond)) {
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    const report = buildRemoteAwareWorkspaceSkillStatus(resolved);
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
    const workspaceDirs = listAgentWorkspaceDirs(cfg);
    const bins = new Set<string>();
    for (const workspaceDir of workspaceDirs) {
      const entries = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
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
      const detail = await fetchClawHubSkillDetail({
        slug: (params as { slug: string }).slug,
      });
      respond(true, detail, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
  "skills.proposals.list": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.list",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalsListParams,
      run: (_parsedParams, resolved) => listSkillProposals({ workspaceDir: resolved.workspaceDir }),
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
          workspaceDir: resolved.workspaceDir,
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
        return proposal;
      },
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
          config: resolved.cfg,
          name: parsedParams.name,
          description: parsedParams.description,
          content: parsedParams.content,
          supportFiles: parsedParams.supportFiles,
          createdBy: "gateway",
          goal: parsedParams.goal,
          evidence: parsedParams.evidence,
        }),
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
          skillName: parsedParams.skillName,
          description: parsedParams.description,
          content: parsedParams.content,
          supportFiles: parsedParams.supportFiles,
          createdBy: "gateway",
          goal: parsedParams.goal,
          evidence: parsedParams.evidence,
        }),
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
          config: resolved.cfg,
          proposalId: parsedParams.proposalId,
          content: parsedParams.content,
          supportFiles: parsedParams.supportFiles,
          description: parsedParams.description,
          goal: parsedParams.goal,
          evidence: parsedParams.evidence,
        }),
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
        const proposal = await inspectSkillProposal(parsedParams.proposalId, {
          workspaceDir: resolved.workspaceDir,
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
        await forwardSkillWorkshopRevisionToChatSend(opts, {
          agentId: resolved.agentId,
          idempotencyKey: parsedParams.idempotencyKey,
          instructions: parsedParams.instructions,
          proposal,
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
      validate: validateSkillsProposalActionParams,
      run: (parsedParams, resolved) =>
        applySkillProposal({
          workspaceDir: resolved.workspaceDir,
          proposalId: parsedParams.proposalId,
          reason: parsedParams.reason,
        }),
    });
  },
  "skills.proposals.reject": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.reject",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalActionParams,
      run: (parsedParams, resolved) =>
        rejectSkillProposal({
          workspaceDir: resolved.workspaceDir,
          proposalId: parsedParams.proposalId,
          reason: parsedParams.reason,
        }),
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
          proposalId: parsedParams.proposalId,
          reason: parsedParams.reason,
        }),
    });
  },
  "skills.install": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsInstallParams, "skills.install", respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    // Skill installs are intentionally routed by source; each source owns its
    // validation, provenance checks, and result payload shape.
    if (params && typeof params === "object" && "source" in params && params.source === "clawhub") {
      const p = params as {
        source: "clawhub";
        slug: string;
        version?: string;
        force?: boolean;
      };
      const result = await installSkillFromClawHub({
        workspaceDir: workspaceDirRaw,
        slug: p.slug,
        version: p.version,
        force: Boolean(p.force),
        config: cfg,
      });
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
            }
          : result,
        result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.error),
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
        config: context.getRuntimeConfig(),
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
      const cfg = context.getRuntimeConfig();
      const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
      const results = await updateSkillsFromClawHub({
        workspaceDir,
        slug: p.slug,
        config: cfg,
      });
      const errors = results.filter((result) => !result.ok);
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
          : errorShape(ErrorCodes.UNAVAILABLE, errors.map((result) => result.error).join("; ")),
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
