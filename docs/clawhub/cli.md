---
summary: "ClawHub CLI entry points for discovering, installing, publishing, and verifying OpenClaw skills and plugins."
read_when:
  - You want to use ClawHub from the command line
  - You want to install ClawHub skills or plugins through OpenClaw
  - You want to publish ClawHub packages
title: "ClawHub CLI"
---

# ClawHub CLI

Two command-line surfaces talk to ClawHub:

- `openclaw skills` / `openclaw plugins` - discover, install, and update
  packages for a local OpenClaw agent or Gateway.
- The standalone `clawhub` CLI - publisher workflows: login, publish, sync,
  and transfer.

## Discover and install

```bash
openclaw skills search "calendar"
openclaw skills install @owner/<slug>
openclaw skills install @owner/<slug> --version <version> --global
openclaw skills install skills-sh:<owner>/<repo>/<slug>
openclaw skills update @owner/<slug>
openclaw skills update --all --acknowledge-clawhub-risk
openclaw skills verify @owner/<slug> --card

openclaw plugins search "calendar"
openclaw plugins install clawhub:<package>
openclaw plugins install clawhub:<package> --acknowledge-clawhub-risk
openclaw plugins update <id-or-npm-spec>
openclaw plugins update --all
```

Skill installs target the active workspace `skills/` directory by default; add
`--global` for the shared managed skills directory. Plugin installs need the
explicit `clawhub:` prefix to force ClawHub resolution over npm, git, or a
local path. Full flag reference: [`openclaw skills`](/cli/skills) and
[`openclaw plugins`](/cli/plugins).

`skills-sh:` is an explicitly external catalog reference. OpenClaw sends it to
ClawHub and installs the exact commit-pinned GitHub source returned by the
resolver; it never downloads skill content from skills.sh directly. Unclaimed
entries are labeled **Not scanned by ClawHub**. Claimed and ClawHub-scanned
skills use the native `@owner/<slug>` form instead.

### Release trust

OpenClaw checks a release's ClawHub trust state before downloading it, for
both skills and plugins. Versioned releases use exact-release trust metadata;
resolver-backed GitHub skills go through ClawHub's install resolver, which
enforces scan and force-install policy before returning a pinned commit.

- **Malicious or blocked** releases are refused outright.
- **Risky** releases (non-clean scan, non-blocking moderation state) print a
  warning and require `--acknowledge-clawhub-risk` to continue
  non-interactively.
- **Official ClawHub publishers/packages and bundled OpenClaw sources** skip
  the trust prompt and security-verdict fetch entirely.

## Publish and maintain

Install the standalone CLI once, then log in:

```bash
npm i -g clawhub
clawhub login
```

Publish a plugin package (folder path, GitHub repo `owner/repo[@ref]`, or
tarball URL) with `clawhub package publish`:

```bash
clawhub package publish ./my-plugin --dry-run
clawhub package publish ./my-plugin
clawhub package publish your-org/your-plugin@v1.0.0
```

Publish a skill folder with `clawhub skill publish`:

```bash
clawhub skill publish ./skills/review-helper
clawhub skill publish ./skills/review-helper --version 1.0.0 --owner your-org
```

Other maintenance commands:

```bash
clawhub sync --all                                          # scan local skills, publish new/updated ones
clawhub package transfer @old-owner/package --to new-owner   # move a plugin package to another publisher
clawhub skill rename old-slug new-slug                       # rename a published skill, redirect the old slug
clawhub explore --sort trending                              # browse the registry, sorted by trending
```

## Related

- [`openclaw skills`](/cli/skills) - local skill search, install, update, and
  verification
- [`openclaw plugins`](/cli/plugins) - plugin search, install, update, and
  inspection
- [ClawHub publishing](/clawhub/publishing) - owner scope, release validation,
  and review flow
- [Creating skills](/tools/creating-skills) - skill authoring and publish flow
- [Building plugins](/plugins/building-plugins) - plugin package authoring
