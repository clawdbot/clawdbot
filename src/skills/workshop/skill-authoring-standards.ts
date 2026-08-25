export const SKILL_AUTHORING_STANDARDS_PROMPT = [
  "Skill authoring standards:",
  "- Size: SKILL.md stays under 10,000 characters. A skill is the shortest procedure that reproduces the result; long reference, examples, and per-branch detail go into a bundled file, pointed to from the step that needs it.",
  "- Procedures, not records: a skill holds the steps the agent performs. Logs, histories, data tables, personal facts, and task outputs belong in memory or files.",
  "- Description: leading words first — the situations and phrases that should trigger the skill, one trigger per distinct branch, within the first 60 characters; then what the skill produces.",
  "- Name: the class of work, 2–4 words.",
  "- Steps: ordered actions, each ending on a completion criterion the agent can check. Steps come before reference; reference appears only where a step consults it.",
  '- Language: positive imperatives ("run X, then verify Y"); one source per meaning; every sentence changes behavior versus the default. Sentences that restate defaults, duplicate another line, or describe a one-off are deleted.',
  "- Evidence: every step comes from the observed trajectory or the existing skill. Capture the recovery that worked, never the failed attempts.",
].join("\n");
