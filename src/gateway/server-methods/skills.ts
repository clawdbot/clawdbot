import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillsBinsParams,
  validateSkillsDetailParams,
  validateSkillsInstallParams,
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
import {
  installSkillFromClawHub,
  readLocalSkillCardContentSync,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} from "../../agents/skills-clawhub.js";
import { installSkill } from "../../agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { loadWorkspaceSkillEntries, type SkillEntry } from "../../agents/skills.js";
import { listAgentWorkspaceDirs } from "../../agents/workspace-dirs.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import {
  fetchClawHubSkillDetail,
  fetchClawHubSkillSecurityVerdicts,
  resolveClawHubBaseUrl,
  type ClawHubSkillSecurityVerdictItem,
} from "../../infra/clawhub.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { updateSkillConfigEntry } from "./skills-config-mutations.js";
import { installUploadedSkillArchive, skillsUploadHandlers } from "./skills-upload.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

function collectSkillBins(entries: SkillEntry[]): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    const required = entry.metadata?.requires?.bins ?? [];
    const anyBins = entry.metadata?.requires?.anyBins ?? [];
    const install = entry.metadata?.install ?? [];
    for (const bin of required) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const bin of anyBins) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const spec of install) {
      const specBins = spec?.bins ?? [];
      for (const bin of specBins) {
        const trimmed = normalizeOptionalString(bin) ?? "";
        if (trimmed) {
          bins.add(trimmed);
        }
      }
    }
  }
  return [...bins].toSorted();
}

type OpenClawSkillSecurityVerdictItem = Omit<
  ClawHubSkillSecurityVerdictItem,
  "decision" | "error" | "security"
> & {
  registry: string;
  decision: string;
  securityStatus?: string | null;
  securityPassed?: boolean | null;
  error?: {
    code?: string;
    message?: string;
  };
};

function readSecurityStatus(security: unknown): string | null | undefined {
  if (!security || typeof security !== "object" || !("status" in security)) {
    return undefined;
  }
  const status = (security as { status?: unknown }).status;
  return typeof status === "string" ? status : undefined;
}

function readSecurityPassed(security: unknown): boolean | null | undefined {
  if (!security || typeof security !== "object" || !("passed" in security)) {
    return undefined;
  }
  const passed = (security as { passed?: unknown }).passed;
  return typeof passed === "boolean" ? passed : undefined;
}

function projectClawHubVerdictItem(
  item: ClawHubSkillSecurityVerdictItem,
  registry: string,
): OpenClawSkillSecurityVerdictItem {
  const projected: OpenClawSkillSecurityVerdictItem = {
    registry,
    ok: item.ok,
    decision: item.decision,
    reasons: item.reasons,
    requestedSlug: item.requestedSlug,
    requestedVersion: item.requestedVersion,
  };
  if (item.slug !== undefined) {
    projected.slug = item.slug;
  }
  if (item.version !== undefined) {
    projected.version = item.version;
  }
  if (item.displayName !== undefined) {
    projected.displayName = item.displayName;
  }
  if (item.publisherHandle !== undefined) {
    projected.publisherHandle = item.publisherHandle;
  }
  if (item.publisherDisplayName !== undefined) {
    projected.publisherDisplayName = item.publisherDisplayName;
  }
  if (item.createdAt !== undefined) {
    projected.createdAt = item.createdAt;
  }
  if (item.checkedAt !== undefined) {
    projected.checkedAt = item.checkedAt;
  }
  if (item.skillUrl !== undefined) {
    projected.skillUrl = item.skillUrl;
  }
  if (item.securityAuditUrl !== undefined) {
    projected.securityAuditUrl = item.securityAuditUrl;
  }
  const securityStatus = readSecurityStatus(item.security);
  if (securityStatus !== undefined) {
    projected.securityStatus = securityStatus;
  }
  const securityPassed = readSecurityPassed(item.security);
  if (securityPassed !== undefined) {
    projected.securityPassed = securityPassed;
  }
  if (item.error) {
    const error: OpenClawSkillSecurityVerdictItem["error"] = {};
    if (typeof item.error.code === "string") {
      error.code = item.error.code;
    }
    if (typeof item.error.message === "string") {
      error.message = item.error.message;
    }
    if (Object.keys(error).length > 0) {
      projected.error = error;
    }
  }
  return projected;
}

function normalizeAutoVerdictRegistryBase(registry: string): string | null {
  try {
    const url = new URL(registry);
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${normalizedPath}`;
  } catch {
    return null;
  }
}

function canAutoFetchVerdictRegistry(registry: string): boolean {
  const configured = normalizeAutoVerdictRegistryBase(resolveClawHubBaseUrl());
  const target = normalizeAutoVerdictRegistryBase(registry);
  return configured !== null && target === configured;
}

function collectClawHubVerdictTargets(report: ReturnType<typeof buildWorkspaceSkillStatus>) {
  const targets = new Map<string, { registry: string; slug: string; version: string }>();
  for (const skill of report.skills) {
    const link = skill.clawhub;
    if (!link || link.status !== "linked" || !link.valid) {
      continue;
    }
    if (!canAutoFetchVerdictRegistry(link.registry)) {
      continue;
    }
    const key = `${link.registry}\0${link.slug}\0${link.installedVersion}`;
    targets.set(key, {
      registry: link.registry,
      slug: link.slug,
      version: link.installedVersion,
    });
  }
  return [...targets.values()];
}

function resolveSkillsAgentWorkspace(params: unknown, context: GatewayRequestContext) {
  const cfg = context.getRuntimeConfig();
  const agentIdRaw =
    params && typeof params === "object" && "agentId" in params
      ? normalizeOptionalString((params as { agentId?: unknown }).agentId)
      : undefined;
  const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
  if (agentIdRaw) {
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

async function fetchOpenClawSkillSecurityVerdicts(
  targets: Array<{ registry: string; slug: string; version: string }>,
): Promise<OpenClawSkillSecurityVerdictItem[]> {
  const byRegistry = new Map<string, Array<{ slug: string; version: string }>>();
  for (const target of targets) {
    const registryTargets = byRegistry.get(target.registry) ?? [];
    registryTargets.push({ slug: target.slug, version: target.version });
    byRegistry.set(target.registry, registryTargets);
  }

  const items: OpenClawSkillSecurityVerdictItem[] = [];
  for (const [registry, registryTargets] of byRegistry) {
    const response = await fetchClawHubSkillSecurityVerdicts({
      baseUrl: registry,
      items: registryTargets,
      skipAuth: true,
    });
    for (const item of response.items) {
      items.push(projectClawHubVerdictItem(item, registry));
    }
  }
  return items;
}

export const skillsHandlers: GatewayRequestHandlers = {
  ...skillsUploadHandlers,
  "skills.status": ({ params, respond, context }) => {
    if (!validateSkillsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.status params: ${formatValidationErrors(validateSkillsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    const report = buildWorkspaceSkillStatus(resolved.workspaceDir, {
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
    respond(true, report, undefined);
  },
  "skills.securityVerdicts": async ({ params, respond, context }) => {
    if (!validateSkillsSecurityVerdictsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.securityVerdicts params: ${formatValidationErrors(validateSkillsSecurityVerdictsParams.errors)}`,
        ),
      );
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    try {
      const report = buildWorkspaceSkillStatus(resolved.workspaceDir, {
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
    if (!validateSkillsSkillCardParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.skillCard params: ${formatValidationErrors(validateSkillsSkillCardParams.errors)}`,
        ),
      );
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
    if (!validateSkillsBinsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.bins params: ${formatValidationErrors(validateSkillsBinsParams.errors)}`,
        ),
      );
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
    if (!validateSkillsSearchParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.search params: ${formatValidationErrors(validateSkillsSearchParams.errors)}`,
        ),
      );
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
    if (!validateSkillsDetailParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.detail params: ${formatValidationErrors(validateSkillsDetailParams.errors)}`,
        ),
      );
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
  "skills.install": async ({ params, respond, context }) => {
    if (!validateSkillsInstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.install params: ${formatValidationErrors(validateSkillsInstallParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
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
        context,
      });
      respond(
        result.ok,
        result,
        result.ok ? undefined : errorShape(result.errorCode, result.error),
      );
      return;
    }
    const p = params as {
      name: string;
      installId: string;
      dangerouslyForceUnsafeInstall?: boolean;
      timeoutMs?: number;
    };
    const result = await installSkill({
      workspaceDir: workspaceDirRaw,
      skillName: p.name,
      installId: p.installId,
      dangerouslyForceUnsafeInstall: p.dangerouslyForceUnsafeInstall,
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
    if (!validateSkillsUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.update params: ${formatValidationErrors(validateSkillsUpdateParams.errors)}`,
        ),
      );
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
