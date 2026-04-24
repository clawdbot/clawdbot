---
name: openclaw-ghsa-maintainer
description: Inspect, patch, validate, publish, or confirm OpenClaw GHSA security advisories and private-fork state.
---

# OpenClaw GHSA Maintainer

Use this skill for repo security advisory workflow only. Keep general release work in `openclaw-release-maintainer`.

## Respect advisory guardrails

- Before reviewing or publishing a repo advisory, read `SECURITY.md`.
- Ask permission before any publish action.
- Treat this skill as GHSA-only. Do not use it for stable or beta release work.

## Fetch and inspect advisory state

Fetch the current advisory and the latest published npm version:

```bash
gh api /repos/openclaw/openclaw/security-advisories/<GHSA>
npm view openclaw version --userconfig "$(mktemp)"
```

Use the fetch output to confirm the advisory state, linked private fork, and vulnerability payload shape before patching.

## Verify private fork PRs are closed

Before publishing, verify that the advisory's private fork has no open PRs:

```bash
fork=$(gh api /repos/openclaw/openclaw/security-advisories/<GHSA> | jq -r .private_fork.full_name)
gh pr list -R "$fork" --state open
```

The PR list must be empty before publish.

## Prepare advisory Markdown and JSON safely

- Write advisory Markdown via heredoc to a temp file. Do not use escaped `\n` strings.
- Build PATCH payload JSON with `jq`, not hand-escaped shell JSON.

Example pattern:

```bash
cat > /tmp/ghsa.desc.md <<'EOF'
<markdown description>
EOF

jq -n --rawfile desc /tmp/ghsa.desc.md \
  '{summary,severity,description:$desc,vulnerabilities:[...]}' \
  > /tmp/ghsa.patch.json
```

## Apply PATCH calls in the correct sequence

- Do not set `severity` and `cvss_vector_string` in the same PATCH call.
- Use separate calls when the advisory requires both fields.
- Publish by PATCHing the advisory and setting `"state":"published"`. There is no separate `/publish` endpoint.

Example shape:

```bash
gh api -X PATCH /repos/openclaw/openclaw/security-advisories/<GHSA> \
  --input /tmp/ghsa.patch.json
```

## Publish and verify success

After publish, re-fetch the advisory and confirm:

- `state=published`
- `published_at` is set
- the description does not contain literal escaped `\\n`

Verification pattern:

```bash
gh api /repos/openclaw/openclaw/security-advisories/<GHSA>
jq -r .description < /tmp/ghsa.refetch.json | rg '\\\\n'
```

## Common GHSA footguns

- Publishing fails with HTTP 422 if required fields are missing or the private fork still has open PRs.
- A payload that looks correct in shell can still be wrong if Markdown was assembled with escaped newline strings.
- Advisory PATCH sequencing matters; separate field updates when GHSA API constraints require it.
