import {
  fetchOwnerQualifiedSkillSecurityVerdict,
  isOwnerQualifiedSkillNotFoundVerdict,
} from "../../infra/clawhub-skill-verdict.js";
// ClawHub verdict helpers normalize skill security verdicts from registry metadata.
import {
  fetchClawHubSkillSecurityVerdicts,
  resolveClawHubBaseUrl,
  type ClawHubSkillSecurityVerdictItem,
} from "../../infra/clawhub.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import type { buildWorkspaceSkillStatus } from "../discovery/status.js";

const OWNER_QUALIFIED_VERDICT_CONCURRENCY = 4;
const OWNER_QUALIFIED_VERDICT_BUDGET_MS = 5_000;

type ClawHubVerdictTarget = {
  registry: string;
  slug: string;
  ownerHandle?: string;
  version: string;
};

/** ClawHub verdict item shape projected into local security scan verdicts. */
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

function needsOwnerQualifiedVerdict(
  item: ClawHubSkillSecurityVerdictItem,
  target: { slug: string; ownerHandle?: string; version: string } | undefined,
): target is { slug: string; ownerHandle: string; version: string } {
  return Boolean(
    target?.ownerHandle &&
    target.slug === item.requestedSlug &&
    target.version === item.requestedVersion &&
    isOwnerQualifiedSkillNotFoundVerdict(item),
  );
}

async function resolveOwnerQualifiedVerdict(params: {
  item: ClawHubSkillSecurityVerdictItem;
  target: { slug: string; ownerHandle?: string; version: string } | undefined;
  registry: string;
  deadlineAtMs: number;
}): Promise<ClawHubSkillSecurityVerdictItem> {
  const { item, target, registry, deadlineAtMs } = params;
  if (!needsOwnerQualifiedVerdict(item, target)) {
    return item;
  }
  const timeoutMs = deadlineAtMs - Date.now();
  if (timeoutMs <= 0) {
    return item;
  }
  try {
    return await fetchOwnerQualifiedSkillSecurityVerdict({
      slug: target.slug,
      ownerHandle: target.ownerHandle,
      version: target.version,
      baseUrl: registry,
      skipAuth: true,
      timeoutMs,
    });
  } catch {
    // Keep the explicit bulk verdict if the compatibility fallback is unavailable.
    return item;
  }
}

async function resolveOwnerQualifiedVerdicts(params: {
  items: ClawHubSkillSecurityVerdictItem[];
  targets: Array<{ slug: string; ownerHandle?: string; version: string }>;
  registry: string;
  deadlineAtMs: number;
}): Promise<ClawHubSkillSecurityVerdictItem[]> {
  const remainingMs = params.deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    return params.items;
  }

  const timedOut = Symbol("owner-qualified-verdict-timeout");
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), remainingMs);
    timer.unref?.();
  });
  const resolvedItems = [...params.items];
  const resolvedPromise = runTasksWithConcurrency({
    limit: OWNER_QUALIFIED_VERDICT_CONCURRENCY,
    tasks: params.items.map((item, index) => async () => {
      resolvedItems[index] = await resolveOwnerQualifiedVerdict({
        item,
        target: params.targets[index],
        registry: params.registry,
        deadlineAtMs: params.deadlineAtMs,
      });
    }),
  });
  try {
    const resolved = await Promise.race([resolvedPromise, timeoutPromise]);
    if (resolved === timedOut) {
      // Passive badge lookup must not wait across multiple fallback waves.
      // Preserve every bulk verdict whose owner-qualified lookup is late.
      return resolvedItems.slice();
    }
    return resolvedItems;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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
  const byRegistry = new Map<
    string,
    Array<{ slug: string; ownerHandle?: string; version: string }>
  >();
  for (const target of targets) {
    const registryTargets = byRegistry.get(target.registry) ?? [];
    registryTargets.push({
      slug: target.slug,
      ...(target.ownerHandle ? { ownerHandle: target.ownerHandle } : {}),
      version: target.version,
    });
    byRegistry.set(target.registry, registryTargets);
  }

  const items: OpenClawSkillSecurityVerdictItem[] = [];
  let ownerFallbackDeadlineAtMs: number | undefined;
  for (const [registry, registryTargets] of byRegistry) {
    const response = await fetchClawHubSkillSecurityVerdicts({
      baseUrl: registry,
      items: registryTargets,
      skipAuth: true,
    });
    const needsOwnerFallback = response.items.some((item, index) =>
      needsOwnerQualifiedVerdict(item, registryTargets[index]),
    );
    if (needsOwnerFallback && ownerFallbackDeadlineAtMs === undefined) {
      ownerFallbackDeadlineAtMs = Date.now() + OWNER_QUALIFIED_VERDICT_BUDGET_MS;
    }
    const resolvedItems = needsOwnerFallback
      ? await resolveOwnerQualifiedVerdicts({
          items: response.items,
          targets: registryTargets,
          registry,
          deadlineAtMs: ownerFallbackDeadlineAtMs!,
        })
      : response.items;
    for (const resolvedItem of resolvedItems) {
      items.push(projectClawHubVerdictItem(resolvedItem, registry));
    }
  }
  return items;
}
