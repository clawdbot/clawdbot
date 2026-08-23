# Structured release report

Apply this contract only while publishing final feedback. The visible Markdown
remains the human report. Append one hidden, versioned payload so dashboards can
consume the same evidence without interpreting prose.

## Build the current run

Derive both representations from the sanitized worksheet evidence. Turn each
distinct tester observation into one finding. Split multiple behaviors into
separate findings; keep expected and observed behavior only when the tester
provided them. A positive check is a `pass`, candidate misbehavior is a
`problem`, and useful neutral context is an `observation`.

Use the surface's live-taxonomy URL fragment as its stable `id`. Use `unmapped`
only when no scorecard surface fits. Include only surfaces with non-empty
**Testing notes**. Do not infer severity, cross-user cluster ids, or whether a
finding is fixed on `main`; dashboard analysis owns those judgments.

Append this envelope after the visible Markdown:

```md
<!-- openclaw-release-validation-report:v1
<compact JSON object>
-->
```

The JSON object has this exact shape:

```json
{
  "schemaVersion": 1,
  "kind": "openclaw-release-validation-report",
  "release": {
    "tag": "vYYYY.M.D-beta.N",
    "candidateCommit": "full candidate commit"
  },
  "revision": 1,
  "updatedAt": "ISO-8601 timestamp",
  "currentRunId": "random UUID",
  "runs": [
    {
      "runId": "random UUID",
      "submittedAt": "ISO-8601 timestamp",
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
  "issueUrl": "https://github.com/openclaw/openclaw/issues/123"
}
```

`result` is `pass`, `problem`, or `observation`. `surfaceId`, `result`, and
`summary` are required. Omit `expected`, `observed`, and `issueUrl` when the
tester did not provide them. Public OpenClaw issue URLs are allowed; other URLs
are plain text only when essential release evidence.

## Keep one report per tester

Resolve the authenticated login with `gh api user`. Enumerate the campaign's
comments and find comments authored by that login containing the exact v1
marker. The login is lookup metadata only; never include it in the payload.

- No matching comment: create one with `revision: 1` and the current run.
- One valid matching comment: retain its `runs`, append the current run, set
  `currentRunId` to the new UUID, increment `revision`, update `updatedAt`, and
  replace that comment. The visible Markdown summarizes the current run.
- Multiple matches, invalid JSON, a different release, or an unsupported schema:
  stop and show the conflicting comment URLs instead of creating another vote.

Consumers count the current run's promotion vote once per GitHub author. Older
runs remain evidence but do not add votes.

## Validate before publishing

The hidden payload is public GitHub content. Apply the visible comment's privacy
filter to every string: no local paths, gateway or environment names,
credentials, raw logs, user identifiers, OCM/setup details, or cleanup details.

Serialize compact JSON. Escape `<`, `>`, and `&` inside JSON strings as Unicode
escapes so content cannot terminate the HTML comment. Parse the serialized bytes
again with `jq -e`, require the exact schema and enum values above, and require
the complete comment to remain below 60,000 UTF-8 bytes. Stop and ask rather
than discard older runs when retaining them would exceed that bound. If any
other validation fails, repair the payload before a GitHub write; never publish
prose without its matching valid payload.

After the create or update, read the comment back. Completion requires the
visible Markdown, marker, JSON, current run id, and promotion vote to match the
locally validated comment exactly.
