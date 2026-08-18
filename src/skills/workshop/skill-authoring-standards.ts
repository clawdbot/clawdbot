export const SKILL_AUTHORING_STANDARDS_PROMPT = [
  "Skill authoring standards:",
  "- Description: write one sentence. Lead with concrete trigger phrases or the task class in the first ~60 characters so the skill index can route the request before loading the body. Keep one trigger per actual branch and collapse synonyms; notes, helpers, or workflows cannot be the sole descriptor.",
  "- Name: choose a lowercase-hyphenated class-level name that will still identify the task a month later. Reject names tied to one session, run ID, incident ID, calendar date, or other temporary artifact.",
  "- Invocation: preserve the current policy unless evidence calls for a change. A model-discoverable skill omits `disable-model-invocation`; a manual-only skill sets it to `true`.",
  "- Procedure: put shared ordered steps before reference material. End every step with a checkable completion criterion. Move branch-only detail into a bundled resource with a direct pointer from the body, and reference every bundled resource.",
  "- Language: use compact positive imperatives and short lines. State the target behavior; reserve prohibitions for hard guardrails and pair them with the target. Keep one source for each meaning. Every sentence must earn its tokens.",
  "- Evidence: never invent flags, commands, paths, APIs, tool behavior, or requirements that the source material does not establish. Omit unsupported details or mark them as unknown.",
  "- Durable learning: capture the working fix, recovery, or procedure. Never preserve a standalone claim that something does not work after the problem may be gone.",
  "- NEVER capture: environment-dependent failures; claims that a tool or provider is broken or unavailable; transient errors that later resolved; one-off task narratives or session recaps; sequences of failed attempts dressed up as best practice; procedures the evidence did not verify.",
].join("\n");
