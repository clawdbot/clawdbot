import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  createOnboardingRecommendationsStore,
  type OnboardingRecommendationsStore,
  type OnboardingRecommendationsRecord,
} from "../state/onboarding-recommendations.js";

type OnboardRecommendationsDeps = {
  read?: () => OnboardingRecommendationsRecord | null;
  acknowledge?: () => OnboardingRecommendationsRecord | null;
  updatePending?: OnboardingRecommendationsStore["updatePending"];
  clearPending?: OnboardingRecommendationsStore["clearPending"];
  clear?: () => boolean;
};

type AcknowledgeOnboardRecommendationsOptions = {
  retry?: readonly string[];
};

const SAFE_INSTALL_ID_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu;

type BootstrapRecommendation = {
  id: string;
  source: "official-plugin" | "clawhub-skill";
  tier: "recommended" | "optional";
};

function createDefaultOnboardingRecommendationsStore(): OnboardingRecommendationsStore {
  const cfg = getRuntimeConfig();
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  return createOnboardingRecommendationsStore({ workspaceDir });
}

function createDefaultStoreAccessor(): () => OnboardingRecommendationsStore {
  let store: OnboardingRecommendationsStore | undefined;
  return () => (store ??= createDefaultOnboardingRecommendationsStore());
}

function isLegacyBareClawHubId(match: OnboardingRecommendationsRecord["matches"][number]): boolean {
  return (
    match.candidate.source === "clawhub-skill" &&
    SAFE_INSTALL_ID_RE.test(match.candidate.id) &&
    !match.candidate.id.startsWith("@")
  );
}

function bootstrapRecommendations(
  record: OnboardingRecommendationsRecord | null,
): BootstrapRecommendation[] {
  if (record?.acceptedAt != null) {
    return [];
  }
  const byInstall = new Map<string, BootstrapRecommendation>();
  for (const match of record?.matches ?? []) {
    const id = match.candidate.id;
    if (
      !SAFE_INSTALL_ID_RE.test(id) ||
      (match.candidate.source === "clawhub-skill" && !id.startsWith("@"))
    ) {
      continue;
    }
    const source = match.candidate.source === "clawhub-skill" ? "clawhub-skill" : "official-plugin";
    const key = `${source}:${id.toLocaleLowerCase("en-US")}`;
    const existing = byInstall.get(key);
    if (!existing || (existing.tier === "optional" && match.tier === "recommended")) {
      byInstall.set(key, { id, source, tier: match.tier });
    }
  }
  return [...byInstall.values()];
}

export function onboardRecommendationsCommand(
  opts: { json?: boolean },
  runtime: RuntimeEnv,
  deps: OnboardRecommendationsDeps = {},
): void {
  const defaultStore = createDefaultStoreAccessor();
  const stored = (deps.read ?? defaultStore().read)();
  const hasLegacyClawHubId = stored?.matches.some(isLegacyBareClawHubId);
  if (hasLegacyClawHubId && stored && stored.acceptedAt == null) {
    const cleared = (deps.clearPending ?? defaultStore().clearPending)({
      expected: stored,
    });
    if (!cleared) {
      runtime.error("Stored recommendations changed; read them again.");
      runtime.exit(1);
      return;
    }
  }
  const record = hasLegacyClawHubId ? null : stored;
  // The bootstrap consumes only safe opaque install ids. Marketplace prose,
  // model reasons, and local app labels are untrusted prompt input.
  const matches = bootstrapRecommendations(record);
  if (opts.json) {
    runtime.log(JSON.stringify(matches, null, 2));
    return;
  }
  if (matches.length === 0) {
    runtime.log("No stored onboarding recommendations.");
    return;
  }
  runtime.log(
    matches
      .map((match) => {
        const source = match.source === "clawhub-skill" ? "ClawHub skill" : "official plugin";
        return `- ${match.id} [${source}; ${match.tier}]`;
      })
      .join("\n"),
  );
}

export function acknowledgeOnboardRecommendationsCommand(
  opts: AcknowledgeOnboardRecommendationsOptions,
  runtime: RuntimeEnv,
  deps: OnboardRecommendationsDeps = {},
): void {
  const defaultStore = createDefaultStoreAccessor();
  const retryIds = [...new Set(opts.retry ?? [])];
  if (retryIds.length > 0) {
    const record = (deps.read ?? defaultStore().read)();
    if (!record || record.acceptedAt != null) {
      runtime.error("No pending onboarding recommendations to retry.");
      runtime.exit(1);
      return;
    }
    const pending = bootstrapRecommendations(record);
    const pendingIds = new Set(pending.map((match) => match.id));
    const unknownIds = retryIds.filter((id) => !pendingIds.has(id));
    if (unknownIds.length > 0) {
      runtime.error(`Unknown pending recommendation id: ${unknownIds.join(", ")}`);
      runtime.exit(1);
      return;
    }
    const retryIdSet = new Set(retryIds);
    const retryMatches =
      record?.matches.filter((match) => retryIdSet.has(match.candidate.id)) ?? [];
    const updated = (deps.updatePending ?? defaultStore().updatePending)({
      matches: retryMatches,
      expected: record,
    });
    if (!updated) {
      runtime.error("Stored recommendations changed; read them again before recording retries.");
      runtime.exit(1);
      return;
    }
    runtime.log(`Onboarding recommendations updated; ${retryIds.length} left pending for retry.`);
    return;
  }
  const record = (deps.acknowledge ?? defaultStore().acknowledge)();
  runtime.log(record ? "Onboarding recommendations acknowledged." : "No stored recommendations.");
}

export function refreshOnboardRecommendationsCommand(
  runtime: RuntimeEnv,
  deps: OnboardRecommendationsDeps = {},
): void {
  const defaultStore = createDefaultStoreAccessor();
  const cleared = (deps.clear ?? defaultStore().clear)();
  runtime.log(
    cleared
      ? "Onboarding recommendations cleared. The next onboarding run will rescan."
      : "No stored recommendations.",
  );
}
