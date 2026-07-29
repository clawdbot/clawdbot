export const SKILL_AUTHORING_STANDARDS_PROMPT = [
  "Skill authoring standards:",
  "- Description: write one sentence. Lead with concrete trigger phrases or the task class in the first ~60 characters so the skill index can route the request before loading the body. Do not use generic filler; notes, helpers, or workflows cannot be the sole descriptor.",
  "- Name: choose a lowercase-hyphenated class-level name that will still identify the task a month later. Reject names tied to one session, run ID, incident ID, calendar date, or other temporary artifact.",
  "- Body: state when to use the skill, give exact procedure steps, name evidenced pitfalls, and include an evidence-backed verification step.",
  "- Token-efficient language: skills load into model context. Use compact imperative language, short lines, and no narration, filler, or obvious restatement. Every sentence must earn its tokens.",
  "- Evidence: never invent flags, commands, paths, APIs, tool behavior, or requirements that the source material does not establish. Omit unsupported details or mark them as unknown.",
  "- Durable learning: capture the working fix, recovery, or procedure. Never preserve a standalone claim that something does not work after the problem may be gone.",
].join("\n");
