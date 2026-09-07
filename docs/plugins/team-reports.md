---
summary: "Daily, weekly, and monthly team reports from GitHub activity and Discord discussion"
read_when:
  - You are installing, enabling, or configuring the Team Reports plugin
  - You want team activity reports in the Control UI
  - You need to generate, export, or troubleshoot stored team reports
title: "Team Reports plugin"
---

Team Reports collects GitHub organization activity and optional Discord
discussion into daily, weekly, and monthly reports. It keeps report history on
the Gateway and adds a **Reports** tab to the [Control UI](/web/control-ui).
Reports include activity counts, per-person history, source warnings, and
optional model-written summaries.

Team Reports is an official external package: it is not part of the core
`openclaw` npm package and is installed on demand from ClawHub or npm. Source
checkouts of the repository load it directly from `extensions/team-reports`.
It stays disabled until you enable it. Report pages use Gateway
authentication. They are not public just because their default path is `/reports`.

## Before you begin

You need a GitHub token that can read your configured organizations,
repositories, and team membership. Collection can only include data that the
token can access. For Discord, use a bot token with access to the selected
guild, channels, threads, and message history. Only explicitly configured
channels and their threads count.

Fine-grained GitHub tokens are supported. Issue searches always specify
`is:issue` or `is:pull-request`, with merge searches limited to pull requests.

Model-written summaries use an agent's configured model and credentials. The
evidence sent to that model can include repository activity and opted-in
Discord excerpts. Set `summaries.enabled: false` to generate reports with
deterministic text and no summary model calls.

## Install and enable Team Reports

Install the package unless you run the Gateway from a source checkout, which
already contains it:

```bash
openclaw plugins install @openclaw/team-reports
```

Then add the following to your OpenClaw configuration, replacing the example
organization, team, and login with your own:

```json5
{
  plugins: {
    entries: {
      "team-reports": {
        enabled: true,
        config: {
          github: {
            token: {
              source: "env",
              provider: "default",
              id: "TEAM_REPORTS_GITHUB_TOKEN",
            },
            orgs: ["example-org"],
            teams: [{ org: "example-org", slug: "maintainers" }],
          },
          people: [{ github: ["example-member"], display: "Example Member" }],
          summaries: { enabled: false },
        },
      },
    },
  },
}
```

Make the referenced environment variable available to the Gateway process.
See [Secret management](/gateway/secrets) for other secret providers. If you
use `plugins.allow`, include `team-reports` in that list.

Restart the Gateway after changing plugin configuration, then check startup:

```bash
openclaw gateway restart
openclaw team-reports status --json
openclaw dashboard
```

On startup, yesterday triggers a catch-up run after 60 seconds unless a
successful run started at or after that day's closing UTC midnight and includes
that day. A completed manual run after close also satisfies catch-up, including
one that finishes during the startup delay or deferred wait. A successful run
that started while the day was still open does not satisfy closed-day catch-up.
Status shows the run, stored periods, next scheduled times, and source warnings.
To request a report immediately, use:

```bash
openclaw team-reports generate --intraday
```

Generation returns a run ID before collection and summarization finish. Check
`status` for the result, then open **Reports** in the Control UI.

## Read reports in the Control UI

The **Reports** tab appears for an enabled plugin and a Control UI connection
with `operator.read`. It embeds the report page in a sandboxed frame. The
Gateway supplies and renews a scoped authentication cookie; no Gateway token
is added to report URLs.

Every report route requires `operator.read`; `operator.write` and `operator.admin`
also satisfy that requirement. The Control UI tab grants `operator.read` through
its scoped cookie. The CLI's Gateway RPC methods already declare their required
read or generation scopes.

Use HTTPS, [Tailscale Serve](/gateway/tailscale), or a browser-trusted loopback
origin. Plain HTTP on a LAN hostname cannot authenticate the frame. Browsers
that block all third-party cookies can also make the tab unavailable.

GitHub and other external links may not open inside the sandboxed frame. Each
page includes **Open in a new window** with that page's own URL. If the browser
blocks that action too, copy the link into a new tab. Gateway authentication
still applies there.

Pages mirror the maintainer report site layout: a banner and activity dateline,
latest-period quick cards, day/week/month history, people timelines, and a
per-person calendar. The generation panel shows scheduler and source health.
Closed and partial periods remain distinct, with coverage and summary warnings
alongside the report.

The theme choice follows you through in-tab navigation via the page fragment
(`#theme=light` or `#theme=dark`). Inside the sandboxed Reports tab, it lasts for
that visit. It persists per browser only where storage is available, such as in
a separate window. Pages choose the theme from the fragment first, then browser
storage when available, then the operating system's light or dark preference,
independently of the Control UI theme.

Relative times and open-day countdowns refresh with a small
inline script that the Content Security Policy allows by nonce. The same script
enables history toggles, member filtering, and the quiet-member switch. Pages
still work without JavaScript: all history rows and members remain available,
and timestamps have server-rendered fallbacks.

The crab artwork and icon are served from the plugin's own `assets` route under
the same authentication and scope checks as report pages. Those assets use a
private one-day cache; report pages and exports remain uncached.

Roster members and other GitHub actors show GitHub avatars from
`avatars.githubusercontent.com`, using the primary GitHub login. Images load
lazily without sending a referrer. Initials remain visible when an image cannot
load; invalid logins use initials only. Display names and Discord IDs are never
used to construct avatar URLs. The pages bundle their styles and use system
fonts, so no external stylesheets, web fonts, or scripts are needed.

## Configuration

All keys below live under `plugins.entries.team-reports.config`. Unknown keys
are rejected. Configuration and secret changes require a Gateway restart;
secrets resolve once when the report service starts.

| Key               | Default        | Behavior                                                                                                                                                                                                                                                               |
| ----------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basePath`        | `"/reports"`   | Absolute route root with nonempty path segments using letters, digits, `.`, `_`, and `-`. It must not use `.` or `..` segments, the `/api/channels` prefix, or equal or sit below an explicitly configured Control UI base path. Trailing slashes are normalized away. |
| `displayTimezone` | `"UTC"`        | IANA timezone for displayed timestamps. Report windows always use UTC.                                                                                                                                                                                                 |
| `github`          | required       | GitHub collection configuration, described below.                                                                                                                                                                                                                      |
| `discord`         | unset          | Optional Discord collection configuration. Omit it to collect GitHub only.                                                                                                                                                                                             |
| `people`          | unset          | Inline identity entries. Mutually exclusive with `peopleFile`.                                                                                                                                                                                                         |
| `peopleFile`      | unset          | Absolute path to a regular JSON file of at most 2 MiB, shaped as `{ "people": [...] }` and using the identity fields below.                                                                                                                                            |
| `summaries`       | defaults below | Model selection and summary enablement.                                                                                                                                                                                                                                |
| `schedule`        | defaults below | UTC collection times and aggregate refreshes.                                                                                                                                                                                                                          |
| `retention.days`  | `400`          | Remove stored reports older than this many days after closed-day runs; `0` keeps all history.                                                                                                                                                                          |

### GitHub

| Key                                 | Default                    | Behavior                                                                                                                                  |
| ----------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `github.token`                      | required                   | Nonempty token string or SecretRef `{ source, provider, id }`. Secret sources are `env`, `file`, `exec`, and `store`. Prefer a SecretRef. |
| `github.orgs`                       | required                   | Nonempty array of organization names to collect.                                                                                          |
| `github.teams`                      | `[]`                       | Roster sources shaped as `{ org, slug }`.                                                                                                 |
| `github.includeDirectCollaborators` | `false`                    | Add direct repository collaborators with push, maintain, or admin access to the roster.                                                   |
| `github.excludeRepos`               | `[]`                       | Repository names in `owner/name` form to skip. Archived repositories are also skipped.                                                    |
| `github.apiBaseUrl`                 | `"https://api.github.com"` | HTTPS API base URL; set this for GitHub Enterprise Server.                                                                                |
| `github.ignoreCommentPatterns`      | `[]`                       | Regular expression source strings. Matching issue comments and PR review comments are excluded. Invalid patterns are rejected.            |

### Discord

The following is an optional partial configuration example. IDs are illustrative:

```json5 validate=false
discord: {
  token: {
    source: "env",
    provider: "default",
    id: "TEAM_REPORTS_DISCORD_TOKEN",
  },
  guildId: "123456789012345678",
  channels: [
    { id: "234567890123456789", excerpts: true },
    { id: "345678901234567890" },
  ],
  excerptMaxChars: 260,
},
```

| Key                           | Default                             | Behavior                                                                                                                    |
| ----------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `discord.token`               | required when Discord is configured | Bot token string or SecretRef with the same shape as `github.token`.                                                        |
| `discord.guildId`             | required when Discord is configured | Guild ID.                                                                                                                   |
| `discord.channels`            | required when Discord is configured | Nonempty array of channel entries, each with an `id` and optional `excerpts`. Their threads also count.                     |
| `discord.channels[].excerpts` | `false`                             | Include bounded message excerpts in reports and the summary evidence. Message counts still contribute when this is `false`. |
| `discord.excerptMaxChars`     | `260`                               | Maximum characters in each excerpt; integer from `1` to `4000`.                                                             |

### People and identity

The roster combines GitHub team members, active identity entries, and direct
collaborators when enabled. Use an identity entry to join a person's GitHub
aliases and Discord user ID:

```json5 validate=false
people: [
  {
    github: ["example-member", "example-member-old"],
    display: "Example Member",
    affiliation: "Example Company",
    roleGroup: "core",
    roleLabel: "Maintainer",
    access: ["release"],
    areas: ["documentation"],
    discordUserId: "456789012345678901",
    discordUsername: "example-member",
    status: "active",
  },
],
```

| Field             | Required | Behavior                                                                                                                                      |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `github`          | yes      | Nonempty login array. The first login is the primary identity; remaining logins are aliases.                                                  |
| `display`         | no       | Display name; defaults to the primary login.                                                                                                  |
| `affiliation`     | no       | Optional affiliation label.                                                                                                                   |
| `roleGroup`       | no       | Group label, such as `core`, `volunteer`, or `readonly`; custom strings are accepted.                                                         |
| `roleLabel`       | no       | Human-readable role label.                                                                                                                    |
| `access`          | no       | Free-form labels, such as `release` or `moderation`; defaults to an empty list. These labels do not grant permissions.                        |
| `areas`           | no       | Ownership areas; defaults to an empty list.                                                                                                   |
| `discordUserId`   | no       | Discord identity used to attribute messages to this person.                                                                                   |
| `discordUsername` | no       | Optional Discord username metadata.                                                                                                           |
| `status`          | no       | `active` or `archived`; omitted entries are active. Archived people are excluded from current reports while stored history remains available. |
| `archivedAt`      | no       | Archive date in `YYYY-MM-DD` form.                                                                                                            |

### Summaries

| Key                   | Default | Behavior                                                                                                                                                    |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `summaries.enabled`   | `true`  | Generate model-written overview, highlights, and per-person summaries. `false` uses deterministic fallback text.                                            |
| `summaries.model`     | unset   | Requested `provider/model` reference; otherwise use the target agent's default model. Requires the host policy below to take effect.                        |
| `summaries.reasoning` | unset   | Requested thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive`, `max`, or `ultra`. The host normalizes it for the selected model. |
| `summaries.agentId`   | unset   | Agent whose model and credentials are used. Cross-agent selection is subject to the host's `llm.allowAgentIdOverride` policy.                               |

To permit a configured summary model, set
`plugins.entries.team-reports.llm.allowModelOverride: true`. The `llm` object
is a sibling of `config`, not a field inside it:

```json5 validate=false
"team-reports": {
  enabled: true,
  llm: { allowModelOverride: true },
  config: {
    // Keep your github and identity configuration here.
    summaries: {
      enabled: true,
      model: "openai/gpt-5.6-sol",
      reasoning: "high",
    },
  },
},
```

Without that opt-in, Team Reports uses the target agent's default model.
Host model allowlists still apply. See the
[plugin LLM runtime](/plugins/sdk-runtime) for those policies.

Summaries are grounded in a bounded evidence digest: totals, leading
repositories and channels, selected activity items, and opted-in excerpts.
They describe observed activity rather than infer performance, employment,
or private facts. Quiet members remain in the report with a low-activity note.

The plugin validates the model's JSON response and retries once to repair
invalid output or missing members. If the retry fails, it keeps the collected
report and shows deterministic summaries with a visible fallback banner.
The output budget scales with roster size; failed model attempts include a bounded, credential-free reason in the report, Markdown export, latest-day status, and Gateway logs.
Unchanged evidence reuses the stored summary instead of making another model
call. Collection is stored before summarization, which may take several minutes.

### Schedule

| Key                           | Default   | Behavior                                                                                                      |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| `schedule.closedDayUtc`       | `"00:05"` | Daily run time in `HH:MM` UTC, before jitter. Generates yesterday's closed report and today's partial report. |
| `schedule.intradayEveryHours` | `4`       | Refresh today's report on aligned UTC hour boundaries; integer from `0` to `24`. `0` disables intraday runs.  |
| `schedule.jitterMinutes`      | `5`       | Maximum random delay added to scheduled runs; integer from `0` to `59`.                                       |
| `schedule.weekly`             | `true`    | Refresh the current ISO week aggregate after daily collection.                                                |
| `schedule.monthly`            | `true`    | Refresh the current month aggregate after daily collection.                                                   |

Only one run executes at a time. Scheduled work waits for an active run;
manual generation is rejected while another run is active. Runs have a
45-minute deadline. Stopping the service cancels its timers and waits up to
30 seconds for active work before closing storage.

## Understand report windows and counts

Daily windows are UTC midnight through the next UTC midnight, with an
exclusive end. Today's report is marked **partial**. ISO weeks start on
Monday and use keys such as `2026-W34`; months use keys such as `2026-08`.
`displayTimezone` changes timestamp labels only, never which report receives
an event.

Weekly and monthly reports sum stored daily reports. They do not recollect
the same period from the APIs. Missing days produce source warnings; generate
the missing daily reports before relying on an aggregate's completeness.
Closed-day runs also finish the week or month containing yesterday when the
UTC date crosses a period boundary.

GitHub merge activity is credited to the person who merged the PR. Commits
credit the author and each mapped coauthor once per person. Identical comments
by the same actor and comment kind count once within the window. Bot activity
is excluded, and nonmember GitHub actors appear separately with counts only.
Members with no activity still appear in the roster.

Pull-request review submissions, including approval and request-changes bodies,
are not collected; inline review comments are included.

Discord totals include unmapped authors, but unmatched entries contain only
the author ID and count, without message content. Excerpts come only from
channels with `excerpts: true`, use collapsed whitespace, and keep the newest
eight per person. A person is active when either their GitHub or Discord
count is nonzero.

Reports keep at most 200 GitHub items and eight Discord excerpts per person,
with at most 80 aggregate top items. Stored report JSON is capped at 2 MiB;
item lists are truncated deterministically, keeping newest items first, and
the report indicates truncation. Counts can therefore exceed displayed items.

## CLI and exports

The CLI talks to the running Gateway and supports `--json` plus the standard
[Gateway client options](/cli/gateway). Reading needs `operator.read`;
generation needs `operator.admin`.

```bash
openclaw team-reports status --json
openclaw team-reports list --json
openclaw team-reports show day 2026-08-20
openclaw team-reports show week 2026-W34 --markdown
openclaw team-reports generate --date 2026-08-20
openclaw team-reports generate --intraday
```

With no date or `--intraday`, generation selects yesterday. `--intraday`
selects today; `--date` accepts a past day or today. Today's report remains
partial. Future dates, or combining `--intraday` with a past date, are rejected.

With the default `basePath`, authenticated readers can use:

| Path                           | Result                                                                  |
| ------------------------------ | ----------------------------------------------------------------------- |
| `/reports/`                    | Report index and recent activity trend.                                 |
| `/reports/latest/`             | Redirect to the latest closed daily report.                             |
| `/reports/day/<key>/`          | Daily HTML report; replace `day` with `week` or `month` for aggregates. |
| `/reports/day/<key>/report.md` | Markdown export; also available for weeks and months.                   |
| `/reports/day/<key>/data.json` | Structured report; also available for weeks and months.                 |
| `/reports/people/`             | Roster index.                                                           |
| `/reports/people/<login>/`     | Per-person history, calendar, and 30-day trend.                         |
| `/reports/index.json`          | Latest keys and stored-period index.                                    |
| `/reports/status`              | Run status, schedule, and source warnings as JSON.                      |

Report and export routes accept only `GET` and `HEAD` and send `Cache-Control: private,
no-store`. Use the CLI or authenticated Gateway method to generate reports;
reading a report page does not trigger collection.

Reports and run records live in the plugin-owned database at
`<state-dir>/plugins/team-reports/team-reports.sqlite`. The plugin closes it
when disabled or restarted. Retention runs after closed-day generation;
set `retention.days: 0` to preserve all report history.

## Troubleshooting

**The Reports tab is missing or unavailable.** Confirm the plugin is enabled,
allowed by `plugins.allow` if present, and the Control UI session has
`operator.read`. Restart the Gateway after config changes. For an unavailable
frame, check HTTPS or trusted loopback access and third-party-cookie policy.

**There are no reports yet.** Run `openclaw team-reports status --json`. Startup
catch-up waits 60 seconds, and collection or model calls may still be running.
Use `generate --intraday` for today's partial report. `/latest/` requires at
least one closed daily report.

**A source has warnings or reports look incomplete.** Read the warnings in
status and the report. Check GitHub token access, organization/team names,
excluded repositories, and Discord bot access to each configured channel and
its history. Rate limits can delay a run. Regenerate affected days once access
or rate limits recover, then refresh aggregates. Changing a secret requires
a Gateway restart.

Repository advisories are optional. An advisory request returning HTTP 403 or
404 counts toward `advisoriesSkipped` in the GitHub source stats without adding
a warning or marking the day stale. Rate-limit responses still wait and retry;
other advisory failures retain their warnings.

Discord collection includes active and archived threads, including forum and
media posts. Private archives require `MANAGE_THREADS` and
`READ_MESSAGE_HISTORY`; if Discord returns HTTP 403, collection falls back to
private threads the bot has joined, using `READ_MESSAGE_HISTORY`.
If both private-archive endpoints return HTTP 403, the channel counts toward
`privateArchivesSkipped` in Discord source stats without a warning or stale
status; other failures retain their warnings.
Private threads the bot cannot access are outside the report's coverage.

Long runs emit `team-reports:` progress lines in the Gateway log when roster,
repository, issue-search, commit, comment/advisory, and Discord collection stages
finish. These lines contain counts and the commit strategy, without tokens or
message content.

**A member is missing or Discord activity is unmatched.** Check the GitHub
team roster and identity entries. Put aliases in the same `github` array,
use the person's Discord user ID, and ensure the entry is not archived.
`discordUsername` alone does not map messages to a person.

**Summaries show a fallback banner or ignore the requested model.** Check the
target agent's authentication and default model, summary settings, and host
LLM policy. A requested model needs `llm.allowModelOverride: true` outside
`config`. Fallback text preserves the report when the model is disabled,
unavailable, or returns invalid output.

**Generation says a run is already active.** Inspect `status` and wait for
that run's outcome. The scheduler prevents overlapping collection, and each
run is bounded by its deadline.

See also: [plugin configuration](/tools/plugin),
[Control UI](/web/control-ui), and [Secret management](/gateway/secrets).
