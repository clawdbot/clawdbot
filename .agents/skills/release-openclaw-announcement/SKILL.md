---
name: release-openclaw-announcement
description: "Draft or post OpenClaw beta, stable, or extended-stable Discord release announcements from changelog, tag, registry, and validation evidence. Use when announcing a release, release candidate, or asking what users should test after an OpenClaw release."
---

# OpenClaw Release Announcement

Use with `release-openclaw-maintainer` after a release is live.
Use with `$discord-user-post` when actually posting to Discord as the logged-in
user.

## Evidence First

Before drafting focus areas, read real release evidence:

1. GitHub release body, or the immutable tag and publish run for extended-stable.
2. `CHANGELOG.md` section for the released base version.
3. Commits since the previous shipped version or the operator-specified base.
4. Registry/package metadata for the exact version and current dist-tag.
5. Validation status that is relevant to user confidence.

Do not claim a full changelog audit unless you did it. If you only read the
generated release notes or top changelog section, say that and either audit
properly or draft with that limitation.

For beta focus areas, prioritize user-observable changes over internal test or
CI mechanics:

- install/update paths
- OS/platform-specific behavior
- Gateway startup/restart, config, and runtime behavior
- provider/model/runtime routing
- plugin loading and local plugin development
- channels and media paths
- security/data-loss/user-impact fixes

Do not let late release-branch fixes automatically dominate the announcement.
If the version includes a large delta from the previous shipped version, rank
focus areas by the whole release delta and expected user impact; mention late
fixes in their natural category.

## Required Copy

Every beta announcement must make beta status explicit and include:

- exact version, e.g. `OpenClaw 2026.5.25-beta.1`
- one-sentence risk framing: beta, useful for testing, not stable promotion
- focused test areas derived from evidence, not guesswork
- update command promoted near the top:
  ```sh
  openclaw update --channel beta --yes
  openclaw --version
  ```
- fresh install path:
  `Install from https://openclaw.ai`
- GitHub release link
- concise validation note, without making CI the headline

Do not suggest npm install commands in beta announcements unless the operator
explicitly asks for npm-specific copy or troubleshooting text. It is fine to use
registry metadata as evidence; do not turn that into public install guidance.

For stable announcements, use the stable channel wording:

```sh
openclaw update --channel stable --yes
openclaw --version
```

Fresh installs still point to `https://openclaw.ai`.

For extended-stable, name the exact version and trailing month. Mention only
observable backports, and use:

```sh
openclaw update --channel extended-stable
openclaw --version
```

Do not add `--yes`: users moving from newer regular stable must see the downgrade
warning because older versions may not understand newer configuration. Link the
tag or changelog; do not imply a GitHub Release or inherit regular stable
macOS, Windows, ClawHub, `latest`, or website claims.

## Style

- Discord Markdown, no tables.
- Keep it skimmable: short intro, bullets, commands, links.
- Lead with what users can feel or test, not proof plumbing.
- Mention validation only after install/update instructions.
- Be specific about where feedback is useful.
- Do not mention private local proof paths in public announcements.
- Do not overstate unverified platforms, channels, or provider behavior.

## Posting

When asked to post, use `$discord-user-post` to operate the logged-in Discord
desktop app as the user. Resolve and visibly verify the exact server/channel,
inspect the final body, and request action-time confirmation before entering or
sending it. Never use OpenClaw channel sends, bots, webhooks, relays, or tokens.
