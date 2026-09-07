# Find or refresh the release campaign

Normalize a beta tag `vYYYY.M.D-beta.N` to the stable train `vYYYY.M.D`. The
canonical issue, label, title, and hidden marker belong to that train; the body
also records the current beta. Testing still targets an immutable latest
`origin/main` SHA.

When the request supplies an issue URL or number in **Validate release**,
resolve it directly with `gh issue view --json number,state,labels,body,url`. Accept it only when it is open, has
the exact `release-validation` label, and contains
`<!-- openclaw-release-validation:<stable-train> -->`. Read the current beta
from the body. Do not search releases or issues first.

When no issue is supplied, use an explicit beta or stable tag when supplied.
Otherwise run `gh api 'repos/openclaw/openclaw/releases?per_page=100'` once and
select the newest published `vYYYY.M.D-beta.N` locally. Do not paginate. If the
bounded response has no beta, ask for an explicit tag.

Without a supplied issue, find the campaign with one bounded lookup:

```sh
gh api 'repos/openclaw/openclaw/issues?state=open&labels=release-validation&per_page=2'
```

Ignore pull requests. Require at most one issue with the label. The label is
the fast index; the stable-train marker is the identity check. Multiple issues
or a different marker are conflicts: show their URLs and stop. Never fall back
to an unbounded issue scan.

In **Validate release**, compare the selected latest beta with the issue's
exact `- Current beta:` line. If the issue is absent or names an older beta,
dispatch the runner. Generate a request id containing UTC time plus a short
random suffix, then run:

```sh
gh workflow run release-validation-skill-runner.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f tag=<selected-beta> \
  -f request_id=<request-id>
```

When the tester supplied an existing issue that still has a legacy
beta-specific marker, also pass `-f campaign_issue=<number>` for that one-time
migration. Never infer an unlabeled issue number from search results.

Find the run by that request id with one bounded `gh run list --workflow
release-validation-skill-runner.yml --event workflow_dispatch --limit 20
--json databaseId,displayTitle,url,status,conclusion`, then
wait with `gh run watch <run-id> --exit-status`. On success, repeat the bounded
issue lookup and require the marker and current-beta line to match. If dispatch
is forbidden, stop with the exact permission error and say that a repository
operator must run the workflow. If the workflow fails, show its URL and stop.
Do not prepare or update a gateway without a current campaign.

In **Update campaign**, always dispatch the same workflow for the selected
explicit tag, wait for it by request id, and verify the resulting issue state.
This is intentionally independent of beta publication and never blocks a
release.

Whenever the workflow reaches its issue announcement, use this exact shape with
one raw URL and no commentary about discovery or campaign counts:

```text
Issue: https://github.com/openclaw/openclaw/issues/<number>
```

In **Validate release**, announce the issue once, read the current beta tag and
commit from its body, and retain the exact bytes between
`<!-- validation-guidance:start -->` and `<!-- validation-guidance:end -->` for
the later ready-only worksheet. After Gateway selection, pin the target once
under [Gateway preparation](gateway-preparation.md) and show
`Test target: origin/main at <full SHA>`. The campaign beta describes the
guidance; that immutable main SHA is the runtime being tested.
