---
summary: "CLI reference for `openclaw promos` (list and claim promotional model offers)"
read_when:
  - You want to try a free promotional model offer from ClawHub
  - You are configuring a provider through a promotion instead of onboarding
title: "Promos"
---

# `openclaw promos`

Discover and claim promotional model offers published on ClawHub. Claiming a
promotion configures the provider (auth and plugin, when needed) and registers
the promotion's models — without re-running onboarding and without changing
your default model unless you say so.

Related:

- Default model and fallbacks: [Models](/cli/models)
- Provider auth setup: [Getting started](/start/getting-started)

## Commands

```bash
openclaw promos list
openclaw promos claim <slug>
openclaw promos claim <slug> --api-key <key> --set-default
```

## `openclaw promos list`

Lists promotions that are currently live, with their models, the suggested
default, time remaining, and the exact claim command. `--json` prints the raw
payload.

## `openclaw promos claim <slug>`

Claims a live promotion:

1. Fetches the promotion from ClawHub and verifies it is inside its window.
2. Validates the promotion's provider, auth choice, and declared plugin packages
   against your installed OpenClaw version. Unknown ids or package mismatches are
   refused — a promotion can never make the CLI run anything it does not already
   know how to do.
3. Reuses your existing provider credentials when you have them. Otherwise it
   walks the provider's normal auth flow (printing the promotion's signup URL
   for a free key first). `--api-key <key>` completes API-key auth without
   prompts, matching the `openclaw onboard` non-interactive flags; to keep the
   key off the command line, export the provider's environment variable
   instead (for example `OPENROUTER_API_KEY`) — existing env credentials are
   detected automatically and no flag is needed.
4. Registers the promotion's models with their aliases. Existing aliases are
   never overwritten.
5. Offers to set the promotion's suggested model as your default —
   `--set-default` skips the question; otherwise nothing about your defaults
   changes.

When the promotion's window ends, the provider stops serving the free models;
your configuration and credentials are untouched. Switch back anytime with
`openclaw models set <model>`.

## Passive discovery in `models list`

`openclaw models list` also surfaces promotions without you asking ClawHub
directly:

- Live offers whose models you have not configured appear in an
  "Available via promotion" group below the table, each with its claim
  command.
- Models you registered through `promos claim` carry a `promo` tag, which
  flips to `promo ended` once the offer's window passes.
- The first time a new offer is seen, a one-time notice points at
  `openclaw promos list`. Offers you have already listed or claimed are never
  announced again.

This reads a locally cached copy of ClawHub's hosted promotions feed
(normally refreshed once a day with a conditional request, or earlier when the
cached snapshot expires; refresh failures are silently skipped). A stale
refresh waits at most 2.5 seconds and never breaks the listing. `--json` and
`--plain` output stay machine-clean: no promotion sections or notices.
Claiming always revalidates against the live ClawHub API, so an offer withdrawn
early is refused even while a cached copy still shows it.
