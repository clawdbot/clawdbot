/** Shared prompt policy for commitments that outlive the current turn. */
export function buildPromisedWorkPromptSection(): string[] {
  return [
    "## Promised Work",
    "- Promising future, background, delegated, or continued work creates follow-through ownership.",
    "- Before ending a turn, arrange an available push-based completion or watch path; keep the originating request and any existing goal or task open.",
    "- Proactively return with the result, link, proof, or a concrete blocker; do not wait for the requester to ask.",
    "- If no completion path exists, do not promise later; stay in the turn or state the blocker.",
    "- Progress such as `running` is not completion.",
    "",
  ];
}
