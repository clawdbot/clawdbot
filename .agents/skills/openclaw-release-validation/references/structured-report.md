# Structured release report

Apply this contract only after the tester approves the complete posting batch.
The visible Markdown remains the human report. Append one hidden payload so
dashboards can consume the same evidence without interpreting prose.

## Build the current run

Derive both representations from the sanitized worksheet and the approved
finding drafts. Turn each distinct tester observation into one finding. A
positive check is `pass`, test-target misbehavior is `problem`, and useful
neutral context is `observation`.

Optional local telemetry may appear only as a short visible evidence note below
the finding it corroborates. It never creates a finding or enters the payload.
The visible **Test environment** profile is also excluded from the payload.
The exact terminal result label is visible report metadata and is also excluded
from the payload; `upgrade.result` continues to describe candidate upgrade
behavior only. A generic **Candidate passed, but cleanup failed** label is
allowed in visible Markdown, but cleanup details remain private tooling data.

Use the live taxonomy URL fragment as a surface `id`; use `unmapped` only when
no scorecard surface fits. Include only surfaces with non-empty **Testing
notes**. Deduplicate a surface that appeared in both campaign priority lists.
Do not infer severity.

Append this envelope after the visible Markdown:

```md
<!-- openclaw-release-validation-report:v2
<compact JSON object>
-->
```

The object has this shape:

```json
{
  "schemaVersion": 2,
  "kind": "openclaw-release-validation-report",
  "campaign": {
    "train": "vYYYY.M.D"
  },
  "revision": 1,
  "updatedAt": "ISO-8601 timestamp",
  "currentRunId": "random UUID",
  "runs": [
    {
      "runId": "random UUID",
      "submittedAt": "ISO-8601 timestamp",
      "beta": {
        "tag": "vYYYY.M.D-beta.N",
        "commit": "full beta commit"
      },
      "testedMainCommit": "full tested origin/main commit",
      "source": {
        "version": "privacy-safe source version",
        "commit": null
      },
      "upgrade": {
        "result": "pass",
        "findings": []
      },
      "surfaces": [
        {
          "id": "models",
          "name": "Models",
          "findings": []
        }
      ],
      "overallFeedback": "tester feedback",
      "promotionVote": "yes"
    }
  ]
}
```

Allowed `upgrade.result` values are `pass`, `problem`, `blocked`, and `unknown`.
Allowed `promotionVote` values are `yes`, `no`, and `unknown`. Use `null` for an
unknown source commit.

Every `findings` item has:

```json
{
  "surfaceId": "models",
  "result": "problem",
  "summary": "Selected model reverted after restart",
  "expected": "The selected model remains active",
  "observed": "The default model was restored",
  "disposition": "new_issue",
  "issueUrl": "https://github.com/openclaw/openclaw/issues/123"
}
```

`surfaceId`, `result`, and `summary` are required. Omit `expected` and
`observed` when the tester did not provide them. For a problem,
`disposition` is `new_issue`, `existing_issue`, or `fixed`. A published finding
requires its public issue or comment URL in `issueUrl`; a fixed finding instead
requires `fixUrl`. Positive and neutral observations omit disposition and URLs.

## Keep one v2 report per tester

Resolve the authenticated login with `gh api user`. Enumerate campaign comments
and find comments authored by that login containing the exact v2 marker. Ignore
historical v1 comments; they belong to the earlier beta-specific schema.

- No v2 comment: create one with `revision: 1` and the current run.
- One valid v2 comment for this train: retain its `runs`, append the current
  run, set `currentRunId` to the new UUID, increment `revision`, update
  `updatedAt`, and replace that comment. The visible Markdown summarizes the
  current run.
- Multiple matches, invalid JSON, another train, or an unsupported schema: stop
  and show the conflicting comment URLs instead of creating another vote.

Consumers count the current run's vote once per GitHub author. Older runs remain
evidence but do not add votes.

## Validate before publishing

The payload is public. No string may contain local paths, gateway/environment
names, credentials, raw logs, user identifiers, OCM/setup details, cleanup
details, telemetry records, prompts, responses, or tool payloads.

Serialize compact JSON. Escape `<`, `>`, and `&` inside strings as Unicode
escapes. Parse the serialized bytes again with `jq -e`; require the exact schema,
enums, campaign train, beta identity, tested main SHA, approved disposition
URLs, and a complete comment below 60,000 UTF-8 bytes. Stop rather than discard
older runs when retention would exceed the limit.

After create or update, read the comment back. Completion requires visible
Markdown, marker, JSON, current run id, beta identity, tested main SHA, finding
URLs, and promotion vote to match the locally validated comment exactly.
