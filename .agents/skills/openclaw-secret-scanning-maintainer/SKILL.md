---
name: openclaw-secret-scanning-maintainer
description: Maintainer-only workflow for handling GitHub Secret Scanning alerts on OpenClaw. Use when Codex needs to triage, redact, clean up, and resolve secret leakage found in issue comments, issue bodies, PR comments, or other GitHub content.
---

# OpenClaw Secret Scanning Maintainer

**Maintainer-only.** This skill requires repo admin / maintainer permissions to edit or delete other users' comments and resolve secret scanning alerts.

Use this skill when processing alerts from `https://github.com/openclaw/openclaw/security/secret-scanning`.

**Language rule:** All notification comments and replacement comments MUST be written in English.

## Script

All mechanical operations (API calls, temp file management, security enforcements) are handled by:

```
$REPO_ROOT/.agents/skills/openclaw-secret-scanning-maintainer/scripts/secret-scanning.mjs
```

The script enforces:

- `hide_secret=true` on all alert fetches (no plaintext secrets in stdout)
- `mktemp` with random UUIDs for all temp files
- `-F body=@file` for all body uploads (no inline shell quoting)
- Notification templates branched by location type
- Never prints `.secret` or `.body` to stdout

## Overall Flow

Supports single or multiple alerts. For multiple alerts, process in ascending order.

For each alert:

1. **Identify** — `fetch-alert` + `fetch-content` to get metadata and body
2. **Decide** — Agent reads the body file, identifies all secrets, produces redacted version
3. **Redact** — `redact-body` for issue/PR body; skip for comments (delete directly)
4. **Purge** — `delete-comment` + `recreate-comment` for comments; cannot purge body history
5. **Notify** — `notify` posts the right template per location type
6. **Resolve** — `resolve` closes the alert
7. **Summary** — `summary` prints formatted results

## Step 1: Identify

```bash
# List all open alerts
node secret-scanning.mjs list-open

# Fetch specific alert metadata + locations
node secret-scanning.mjs fetch-alert <NUMBER>

# Fetch content for each location (saves body to temp file)
node secret-scanning.mjs fetch-content '<location-json>'
```

The `fetch-content` output includes:

- `body_file`: path to temp file with full body content
- `author`: who posted it
- `issue_number` / `pr_number`: where it is
- `edit_history_count`: number of existing edits
- `type`: location type for routing

### Location type routing

| type                          | Flow                     |
| ----------------------------- | ------------------------ |
| `issue_comment`               | Comment: delete+recreate |
| `pull_request_comment`        | Comment: delete+recreate |
| `pull_request_review_comment` | Comment: delete+recreate |
| `issue_body`                  | Body: redact in place    |
| `pull_request_body`           | Body: redact in place    |
| `commit`                      | Notify only              |
| _other_                       | Skip and report          |

## Step 2: Decide (Agent)

The agent reads the body file from `fetch-content` output and:

1. Identifies ALL secrets in the content (there may be more than the alert flagged)
2. Replaces each secret with `[REDACTED <secret_type>]` — **no partial values, no prefix/suffix**
3. Saves the redacted content to a new temp file

This is the only step that requires semantic understanding. Everything else is mechanical.

## Step 3: Redact

### For comments (issue_comment / PR comments)

**Do NOT redact.** Skip directly to Step 4 (delete + recreate). PATCHing before DELETE creates an unnecessary edit history revision.

### For issue_body / pull_request_body

```bash
node secret-scanning.mjs redact-body <issue|pr> <NUMBER> <redacted-body-file>
```

## Step 4: Purge Edit History

### Comments — Delete and Recreate

```bash
# Delete original (all edit history gone)
node secret-scanning.mjs delete-comment <COMMENT_ID>

# Recreate with redacted content
# Agent prepares the body file with maintainer header + redacted content
node secret-scanning.mjs recreate-comment <ISSUE_NUMBER> <body-file>
```

The recreated comment should follow this format:

```
> **Note from maintainer (@<LOGIN>):** The original comment by @<AUTHOR> has been removed due to secret leakage. Below is the redacted version of the original content.

---

<redacted original content>
```

### issue_body / pull_request_body — Cannot Purge

Editing creates an edit history revision with the pre-edit plaintext. This cannot be cleared via API.

**Output to maintainer terminal only (never in public comments):**

```
⚠️ Issue/PR body edit history still contains plaintext secrets.
Contact GitHub Support to purge: https://support.github.com/contact
Request purge of issue/PR #{NUMBER} userContentEdits.
```

> **CRITICAL:** Do NOT mention edit history or the "edited" button in any public comment or resolution_comment.

### Commits

Cannot clean. Notify author to delete branch or force-push (for unmerged PRs).

## Step 5: Notify

```bash
node secret-scanning.mjs notify <ISSUE_NUMBER> <AUTHOR> <LOCATION_TYPE> <SECRET_TYPES>
```

Secret types are comma-separated: `"Discord Bot Token,Feishu App Secret"`

The script picks the right template:

- **comment types**: "your comment … removed and replaced"
- **body types**: "your issue/PR description … redacted in place"
- **commit**: "code you committed"

## Step 6: Resolve

```bash
node secret-scanning.mjs resolve <ALERT_NUMBER>
# or with custom resolution:
node secret-scanning.mjs resolve <ALERT_NUMBER> revoked "Custom comment"
```

Resolution is `revoked` by default. As maintainers we cannot control whether users rotate — our responsibility is to redact + notify. The `revoked` means "this secret should be considered leaked", not "I confirmed it was revoked".

## Step 7: Summary

After processing, create a JSON results file and pass it to the summary command:

```bash
node secret-scanning.mjs summary /tmp/results.json
```

The script outputs a block delimited by `---BEGIN SUMMARY---` and `---END SUMMARY---`. **You MUST output the content between these markers verbatim to the user. Do NOT rephrase, reformat, abbreviate, or create your own summary.** The script already includes full URLs for every alert and location.

The JSON format:

```json
[
  {
    "number": 72,
    "secret_type": "Discord Bot Token",
    "location_label": "Issue #63101 comment",
    "location_url": "https://github.com/openclaw/openclaw/issues/63101#issuecomment-xxx",
    "actions": "Deleted+Recreated+Notified",
    "history_cleared": true
  }
]
```

For unsupported types, add `"skipped": true, "unsupported_type": "<type>"`.

## Safety Rules

- **Agent reads content, identifies secrets, produces redaction.** Script handles all API calls.
- **Never include any portion of a secret** in public comments, redaction markers, or terminal output.
- **Never include alert URLs or numbers** in public comments.
- **For comments, skip PATCH — go directly to DELETE + recreate.**
- **Never mention edit history, "edited" button, or commit SHAs** in any public content.
- **Ask for confirmation** before deleting any comment.
- **One alert at a time** unless user requests batch.
- **All public comments in English.**
- **Skip unsupported location types** and report in summary.
