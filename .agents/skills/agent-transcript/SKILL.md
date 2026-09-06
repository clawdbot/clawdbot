---
name: agent-transcript
description: "Requested GitHub PR/issue agent transcripts: redact, trim, preview, and insert safely."
---

# Agent Transcript

Use only when the user explicitly requests a transcript or preview. Omit by
default; never offer one or ask whether to include one during ordinary PR work.
A preview request alone does not authorize publication.

## Prepare Locally

The helper reads local Codex, Claude, Pi, and OpenClaw logs; no network is used
for discovery/rendering. Never upload raw logs.

```bash
.agents/skills/agent-transcript/scripts/agent-transcript find \
  --query "$PR_TITLE $BRANCH_OR_PR_URL" --cwd "$PWD" --since-days 14
.agents/skills/agent-transcript/scripts/agent-transcript render \
  --session "$SESSION_JSONL" --out /tmp/agent-transcript.md
```

`find` scans the newest 400 matching logs by default; `--max-files N` widens
local discovery. Treat matches as candidates, not proof of scope.

Automatically trim the rendered Markdown **before showing, previewing, or
inserting it**. Keep only task-relevant user prompts, visible decisions, terse
tool summaries, and proof outcomes. Use the PR/issue goal, branch, and changed
files to remove unrelated earlier/later turns. Drop system/developer prompts,
reasoning, raw tool output, environment data, local paths, credentials,
browser/session/cookie details, and auth URLs. Inspect the trimmed result;
helper redaction is not sufficient disclosure review. Unresolved sensitive
content means omit the transcript.

## Preview And Insert

Show the trimmed Markdown for a requested preview. If HTML is requested, build
the local preview from that trimmed content. The helper's `preview`, `html`, and
`append-body` modes render the session again; they do not consume an edited
Markdown file and can reintroduce removed turns. Do not use their untrimmed
output as the approved artifact.

Insert only the inspected, scoped text when the user's authorization specifically
covers publishing that transcript to the named PR/issue. Generating or previewing
a transcript does not authorize publication, even when ordinary PR creation or
editing is already approved. If that scope is missing, show the trimmed result
and obtain publication authorization before insertion. Existing explicit
authorization covering transcript publication needs no repeat confirmation.
Keep the collapsed `<details>` section and replace existing transcript markers
instead of duplicating them. No safe match means continue the PR work without
transcript or placeholder; explain the omission when it prevents the explicitly
requested transcript. Do not promote transcript inclusion as a review priority
requirement.
