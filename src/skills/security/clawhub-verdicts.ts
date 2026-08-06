import { fetchExactClawHubSkillSecurityVerdicts } from "../../infra/clawhub-skill-security.js";
// ClawHub verdict helpers normalize skill security verdicts from registry metadata.
import {
  resolveClawHubBaseUrl,
  type ClawHubSkillSecurityVerdictItem,
} from "../../infra/clawhub.js";
import type { buildWorkspaceSkillStatus } from "../discovery/status.js";

/** ClawHub verdict item shape projected into local security scan verdicts. */
type ClawHubVerdictTarget = {
  registry: string;
  slug: string;
  ownerHandle?: string;
  version: string;
};

type OpenClawSkillSecurityVerdictItem = Omit<
  ClawHubSkillSecurityVerdictItem,
  "decision" | "error" | "security"
> & {
  registry: string;
  decision: string;
  requestedOwnerHandle?: string;
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
  target: ClawHubVerdictTarget,
): OpenClawSkillSecurityVerdictItem {
  const projected: OpenClawSkillSecurityVerdictItem = {
    registry: target.registry,
    ok: item.ok,
    decision: item.decision,
    reasons: item.reasons,
    requestedSlug: target.slug,
    requestedVersion: target.version,
    ...(target.ownerHandle ? { requestedOwnerHandle: target.ownerHandle } : {}),
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

export function collectClawHubVerdictTargets(
  report: ReturnType<typeof buildWorkspaceSkillStatus>,
): ClawHubVerdictTarget[] {
  const targets = new Map<string, ClawHubVerdictTarget>();
  for (const skill of report.skills) {
    const link = skill.clawhub;
    if (!link || link.status !== "linked" || !link.valid) {
      continue;
    }
    if (!canAutoFetchVerdictRegistry(link.registry)) {
      continue;
    }
    const key = `${link.registry}\0${link.ownerHandle ?? ""}\0${link.slug}\0${link.installedVersion}`;
    targets.set(key, {
      registry: link.registry,
      slug: link.slug,
      ...(link.ownerHandle ? { ownerHandle: link.ownerHandle } : {}),
      version: link.installedVersion,
    });
  }
  return [...targets.values()];
}

export async function fetchOpenClawSkillSecurityVerdicts(
  targets: ClawHubVerdictTarget[],
): Promise<OpenClawSkillSecurityVerdictItem[]> {
  const byRegistry = new Map<string, ClawHubVerdictTarget[]>();
  for (const target of targets) {
    const registryTargets = byRegistry.get(target.registry) ?? [];
    registryTargets.push(target);
    byRegistry.set(target.registry, registryTargets);
  }

  const items: OpenClawSkillSecurityVerdictItem[] = [];
  for (const [registry, registryTargets] of byRegistry) {
    const verdicts = await fetchExactClawHubSkillSecurityVerdicts({
      baseUrl: registry,
      items: registryTargets.map(({ slug, ownerHandle, version }) => ({
        slug,
        ...(ownerHandle ? { ownerHandle } : {}),
        version,
      })),
      skipAuth: true,
    });
    for (const [index, item] of verdicts.entries()) {
      items.push(projectClawHubVerdictItem(item, registryTargets[index]!));
    }
  }
  return items;
}
