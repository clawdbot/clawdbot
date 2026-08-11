// Memory Wiki plugin module implements prompt section behavior.
import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-host-core";
import {
  loadMemoryWikiCompiledCache,
  type MemoryWikiCompiledCacheSnapshot,
  type MemoryWikiCompiledDigestClaim,
  type MemoryWikiCompiledDigestPage,
} from "./compiled-cache.js";
import type { MemoryWikiConfigResolver, ResolvedMemoryWikiConfig } from "./config.js";

const DIGEST_MAX_PAGES = 4;
const DIGEST_MAX_CLAIMS_PER_PAGE = 2;

function rankPromptDigestPage(page: MemoryWikiCompiledDigestPage): number {
  return (
    (page.contradictions?.length ?? 0) * 6 +
    (page.questions?.length ?? 0) * 4 +
    Math.min(page.claimCount ?? 0, 6) * 2 +
    Math.min(page.topClaims?.length ?? 0, 3)
  );
}

function rankPromptClaimFreshness(level?: string): number {
  switch (level) {
    case "fresh":
      return 3;
    case "aging":
      return 2;
    case "stale":
      return 1;
    default:
      return 0;
  }
}

function sortPromptClaims(
  claims: MemoryWikiCompiledDigestClaim[],
): MemoryWikiCompiledDigestClaim[] {
  return [...claims].toSorted((left, right) => {
    const leftConfidence = typeof left.confidence === "number" ? left.confidence : -1;
    const rightConfidence = typeof right.confidence === "number" ? right.confidence : -1;
    if (leftConfidence !== rightConfidence) {
      return rightConfidence - leftConfidence;
    }
    const leftFreshness = rankPromptClaimFreshness(left.freshnessLevel);
    const rightFreshness = rankPromptClaimFreshness(right.freshnessLevel);
    if (leftFreshness !== rightFreshness) {
      return rightFreshness - leftFreshness;
    }
    return left.text.localeCompare(right.text);
  });
}

function formatPromptClaim(claim: MemoryWikiCompiledDigestClaim): string {
  const qualifiers = [
    claim.status?.trim() ? `status ${claim.status.trim()}` : null,
    typeof claim.confidence === "number" ? `confidence ${claim.confidence.toFixed(2)}` : null,
    claim.freshnessLevel?.trim() ? `freshness ${claim.freshnessLevel.trim()}` : null,
  ].filter(Boolean);
  if (qualifiers.length === 0) {
    return claim.text;
  }
  return `${claim.text} (${qualifiers.join(", ")})`;
}

function buildDigestPromptSection(
  digest: MemoryWikiCompiledCacheSnapshot["digest"] | undefined,
): string[] {
  if (!digest?.pages?.length) {
    return [];
  }

  const selectedPages = [...digest.pages]
    .filter(
      (page) =>
        (page.claimCount ?? 0) > 0 ||
        (page.questions?.length ?? 0) > 0 ||
        (page.contradictions?.length ?? 0) > 0,
    )
    .toSorted((left, right) => {
      const leftScore = rankPromptDigestPage(left);
      const rightScore = rankPromptDigestPage(right);
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      return left.title.localeCompare(right.title);
    })
    .slice(0, DIGEST_MAX_PAGES);

  if (selectedPages.length === 0) {
    return [];
  }

  const lines = [
    "## Compiled Wiki Snapshot",
    `Compiled wiki currently tracks ${digest.claimCount ?? 0} claims across ${selectedPages.length} high-signal pages.`,
  ];
  lines.push(`Contradiction clusters: ${digest.contradictionCount}.`);
  for (const page of selectedPages) {
    const details = [
      page.kind,
      `${page.claimCount} claims`,
      (page.questions?.length ?? 0) > 0 ? `${page.questions?.length} open questions` : null,
      (page.contradictions?.length ?? 0) > 0
        ? `${page.contradictions?.length} contradiction notes`
        : null,
    ].filter(Boolean);
    lines.push(`- ${page.title}: ${details.join(", ")}`);
    for (const claim of sortPromptClaims(page.topClaims ?? []).slice(
      0,
      DIGEST_MAX_CLAIMS_PER_PAGE,
    )) {
      lines.push(`  - ${formatPromptClaim(claim)}`);
    }
  }
  lines.push("");
  return lines;
}

function buildWikiToolGuidance(availableTools: Set<string>): string[] {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");
  const hasWikiSearch = availableTools.has("wiki_search");
  const hasWikiGet = availableTools.has("wiki_get");
  const hasWikiApply = availableTools.has("wiki_apply");
  const hasWikiLint = availableTools.has("wiki_lint");

  if (
    !hasMemorySearch &&
    !hasMemoryGet &&
    !hasWikiSearch &&
    !hasWikiGet &&
    !hasWikiApply &&
    !hasWikiLint
  ) {
    return [];
  }

  const lines = [
    "## Compiled Wiki",
    "Use the wiki when the answer depends on accumulated project knowledge, prior syntheses, entity pages, or source-backed notes that should survive beyond one conversation.",
  ];

  if (hasMemorySearch) {
    lines.push(
      "Prefer `memory_search` with `corpus=all` for one recall pass across durable memory and the compiled wiki when both are relevant.",
    );
  }
  if (hasMemoryGet) {
    lines.push(
      "Use `memory_get` with `corpus=wiki` or `corpus=all` when you already know the page path and want a small excerpt without leaving the shared memory tool flow.",
    );
  }

  if (hasWikiSearch && hasWikiGet) {
    lines.push(
      "Workflow: `wiki_search` first, then `wiki_get` for the exact page or imported memory file you need. Use this when you want wiki-specific ranking or provenance details instead of the broader shared memory flow.",
    );
  } else if (hasWikiSearch) {
    lines.push(
      "Use `wiki_search` before answering from stored knowledge when you want wiki-specific ranking or provenance details.",
    );
  } else if (hasWikiGet) {
    lines.push(
      "Use `wiki_get` to inspect specific wiki pages or imported memory files by path/id.",
    );
  }

  if (hasWikiApply) {
    lines.push(
      "Use `wiki_apply` for narrow synthesis filing and metadata repair instead of rewriting managed markdown blocks by hand.",
    );
  }
  if (hasWikiLint) {
    lines.push("After meaningful wiki updates, run `wiki_lint` before trusting the vault.");
  }
  lines.push("");
  return lines;
}

export function createWikiPromptSectionBuilder(): MemoryPromptSectionBuilder {
  return ({ availableTools }) => buildWikiToolGuidance(availableTools);
}

export function createWikiPromptSectionPreparer(params: {
  config: ResolvedMemoryWikiConfig;
  resolveConfig: MemoryWikiConfigResolver;
}) {
  return async ({ agentId }: Parameters<MemoryPromptSectionBuilder>[0]) => {
    // Context-free preparation must not choose or disclose another agent's vault.
    if (params.config.vault.scope === "agent" && !agentId) {
      return [];
    }
    const config = params.resolveConfig(agentId);
    if (!config.context.includeCompiledDigestPrompt) {
      return [];
    }
    const snapshot = await loadMemoryWikiCompiledCache(config);
    return buildDigestPromptSection(snapshot?.digest);
  };
}
