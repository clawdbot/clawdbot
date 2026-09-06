import type { applyMemoryWikiMutation } from "./apply.js";
import type { searchMemoryWiki } from "./query.js";

type WikiSearchResults = Awaited<ReturnType<typeof searchMemoryWiki>>;
type WikiMutationResult = Awaited<ReturnType<typeof applyMemoryWikiMutation>>;

export function renderWikiSearchResults(results: WikiSearchResults): string {
  return results.length === 0
    ? "No wiki or memory results."
    : results
        .map(
          (result, index) =>
            `${index + 1}. ${result.title} (${result.corpus}/${result.kind})\nPath: ${result.path}${typeof result.startLine === "number" && typeof result.endLine === "number" ? `\nLines: ${result.startLine}-${result.endLine}` : ""}${result.provenanceLabel ? `\nProvenance: ${result.provenanceLabel}` : ""}${result.matchedClaimId ? `\nClaim: ${result.matchedClaimId}` : ""}${result.evidenceKinds && result.evidenceKinds.length > 0 ? `\nEvidence: ${result.evidenceKinds.join(", ")}` : ""}\nSnippet: ${result.snippet}`,
        )
        .join("\n\n");
}

export function renderWikiMutationSummary(result: WikiMutationResult): string {
  return `${result.changed ? "Updated" : "No changes for"} ${result.pagePath} via ${result.operation}. ${result.compile.updatedFiles.length > 0 ? `Refreshed ${result.compile.updatedFiles.length} index file${result.compile.updatedFiles.length === 1 ? "" : "s"}.` : "Indexes unchanged."}`;
}
