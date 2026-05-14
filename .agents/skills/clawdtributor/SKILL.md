---
name: clawdtributor
description: "Use for OpenClaw clawtributors PR/issue triage: Discrawl discovery, live-open rechecks, deep review, topic grouping, and compact @handle/LOC/type/blast/verification summaries."
---

# Clawdtributor

Use for the `#clawtributors` queue: Discord-discovered OpenClaw PRs/issues that need live GitHub status plus maintainer-quality review.

## Compose with other skills

- `$discrawl`: local Discord archive sync/search.
- `$openclaw-pr-maintainer`: live GitHub PR/issue review, duplicate search, close/land rules.
- `$gitcrawl`: related issue/PR and current-main/stale-proof search.
- `$openclaw-testing` / `$crabbox`: proof choice when a candidate needs real validation.

## Archive flow

Local archive first; verify freshness for current questions.

```bash
discrawl status --json
discrawl sync
```

Resolve channel if needed:

```bash
sqlite3 "$HOME/.discrawl/discrawl.db" \
  "select id,name from channels where name like '%clawtributor%' order by name;"
```

Current known channel id from prior work: `1458141495701012561`. Re-resolve if it stops matching.

Extract recent refs:

```bash
sqlite3 "$HOME/.discrawl/discrawl.db" "
select m.created_at, coalesce(nullif(mm.username,''), m.author_id), m.content
from messages m
left join members mm on mm.guild_id=m.guild_id and mm.user_id=m.author_id
where m.channel_id='1458141495701012561'
  and m.created_at >= '<ISO cutoff>'
order by m.created_at desc;" |
perl -nE 'while(m{github\.com/openclaw/openclaw/(pull|issues)/(\d+)}g){say "$1\t$2\t$_"}'
```

Map a PR/issue back to the Discord handle:

```bash
sqlite3 -separator $'\t' "$HOME/.discrawl/discrawl.db" "
select m.created_at,
       coalesce(nullif(mm.username,''), nullif(mm.global_name,''), m.author_id)
from messages m
left join members mm on mm.guild_id=m.guild_id and mm.user_id=m.author_id
where m.channel_id='1458141495701012561'
  and m.content like '%github.com/openclaw/openclaw/<pull-or-issues>/<number>%'
order by m.created_at desc
limit 1;"
```

Show only `@handle` in the final list. Do not write the word Discord unless the user asks for source details.

## Live GitHub recheck

Always recheck live state before listing, closing, or saying "open".

```bash
GITHUB_TOKEN= GITHUB_TOKEN_NODIFF= GH_TOKEN= \
gh api repos/openclaw/openclaw/pulls/<number> \
  --jq '. | {number,title,state,merged,mergeable,draft,author:.user.login,url:.html_url,updatedAt:.updated_at,additions,deletions,changedFiles:.changed_files}'
```

For issues:

```bash
GITHUB_TOKEN= GITHUB_TOKEN_NODIFF= GH_TOKEN= \
gh api repos/openclaw/openclaw/issues/<number> \
  --jq '. | {number,title,state,author:.user.login,url:.html_url,updatedAt:.updated_at,pull_request}'
```

If `gh` says bad credentials, clear env vars with empty assignments as above. Use `--jq '. | {...}'` for object projections.

## Review depth

For each open item, inspect enough to classify risk:

- PR body, linked issue, comments, files, additions/deletions, checks.
- Current `origin/main` code path and adjacent tests.
- Related threads with `gitcrawl neighbors/search`.
- Whether main already fixed it, the PR is obsolete, or the idea is invalid.
- Blast radius: touched runtime surfaces, config/schema, plugin/core boundary, user-visible behavior, release/package surface.
- Verification: say if local unit/docs proof is enough, live/provider proof is needed, or it is not directly verifiable.

Do not close from title alone. If closing as done on main or nonsensical, prove it against current main and comment first when mutation is requested. Bulk close/reopen above 5 requires explicit scope.

## Candidate selection

When asked for `5 new`, exclude refs already surfaced in the session and refill from the archive until there are 5 live-open candidates. If fewer than 5 remain open, list all open ones and say how many short.

When asked to `update`, `refresh`, `recheck`, `check again`, or similar, return an updated live-open candidate list. Do not fill the main list with items that merely merged/closed since the last pass; put those numbers in a short bottom line.

Prefer:

- Fresh, open, external contributor work.
- Small, high-confidence bugfixes.
- Clear repro, tests, or obvious code-path proof.

Demote:

- Broad product/features without owner decision.
- Large rewrites with unclear contract.
- PRs already in progress, merged, closed, duplicate, or fixed on main.

## Topic grouping

Group only when useful or requested:

- Agents/tooling
- Providers/auth/models
- Channels/messaging
- UI/web
- Gateway/protocol/runtime
- Config/memory/cache
- Docker/install/release
- Docs/tests/chore
- Closed/obsolete

Infer topic from labels, touched files, title/body, and actual code path.

## Output format

No Markdown tables. Compact bullets. Use color/risk markers:

- 🟢 low/narrow
- 🟡 medium or needs targeted proof
- 🔴 broad/high runtime risk
- 🟣 security/policy/owner-boundary slow review
- ✅ merged
- ⚪ closed unmerged

Required line shape:

```markdown
- **PR #81244** `@whatsskill.` `+118/-1` `bug` 🟢 verifiable: yes. This prevents chat action buttons from overlapping short assistant replies. Blast: web chat rendering, low.
- **Issue #81245** `@alice` `LOC n/a` `bug` 🟡 verifiable: partial. This reports duplicate Telegram replies when reconnecting after gateway restart. Blast: Telegram channel runtime, medium.
```

Rules:

- Bold the `PR #n` or `Issue #n` marker.
- Use `@handle`, not author bio text.
- PR LOC is `+additions/-deletions`; issue LOC is `LOC n/a`.
- Type: `bug`, `feature`, `perf`, `security`, `docs`, `test`, `chore`, or `refactor`.
- Write a full sentence for what it does.
- Always include blast radius in one phrase.
- Always include `verifiable: yes|partial|no` plus the shortest proof hint when helpful.
- If status is not open, still show it only when the user asked for all surfaced refs; use ✅ or ⚪ and state merged/closed.
- For refresh-style asks, bottom line: `Merged/closed since last pass: #81016 merged, #81026 closed.` Omit if none.
