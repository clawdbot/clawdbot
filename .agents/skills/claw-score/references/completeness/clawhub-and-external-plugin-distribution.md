# ClawHub Completeness

Use this rubric when assigning category Completeness scores for the
`clawhub-and-external-plugin-distribution` surface.

## Category Scope

- Publishing: ClawHub package publishing owner, OpenClaw-owned package release validation for ClawHub, Version bump gates, npm trusted publishing provenance, External code plugin package contract required, Skill package metadata, Skill publishing flow
- Catalog Discovery: openclaw plugins search as the ClawHub, Search result metadata, Distinction between plugin search, Catalog lookup failure, Skill catalog search
- Compatibility and Trust: openclaw.compat.pluginApi, ClawHub package compatibility validation, npm compatibility fallback to the newest, Official external plugin catalog behavior, Compatibility docs, Operator trust model for installing, ClawHub archive, npm integrity drift, Built-in dangerous-code scanner, ClawHub publishing review/hidden-release behavior as upstream, Skill archive safety, Skill audit signals
- Plugin Lifecycle: Source prefixes, Bare package behavior during the launch, Explicit pinned versions, Managed install records that preserve source, Codex, Local, Marketplace list, Supported mapped features, Remote marketplace path safety, Update by plugin id, Reinstall vs update semantics, Downgrade, Uninstall config/index/policy/file cleanup, Gateway restart/reload requirements after, ClawHub skill installs, Skill upload install path, Skill dependency installers
- Plugin Health: Per-plugin managed npm project, npm-pack local release-candidate installs, Dependency ownership between plugin packages, Peer dependency relinking, Legacy dependency root cleanup, plugins list, Local plugin index, Troubleshooting stale config, Runtime verification after Gateway
