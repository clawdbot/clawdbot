# Plugin Surface Completeness

Use this rubric when assigning category Completeness scores for the
`plugin-sdk-and-bundled-plugin-architecture` surface.

## Surface-Specific Scoring Questions

For each category, ask:

- Can the intended plugin task be completed end to end by an author or
  operator?
- Are the important plugin variants present for this category, such as channel,
  provider, tool, bundled, local, npm, or ClawHub flows?
- Are the main lifecycle stages present where relevant: create, configure,
  validate, run, update, and remove or roll back?
- Are compatibility, approval, or safety branches present when the category
  implies them?
- Are important author/operator-visible gaps still forcing workarounds or
  unsupported paths?

## Surface-Specific Guidance

Variation from the default completeness process:

- Completeness is the plugin author or operator lifecycle for authoring, packaging, installing, running, approving, publishing, and testing plugins, not just SDK or runtime primitives.
- Score the plugin surface against the full plugin journey, not only one import path, packaging mode, or runtime path.
- Bundled-only support or support for only selected plugin families is incomplete when the category implies broader plugin capability.
- Publishing and testing categories should include expected lifecycle support, not just raw commands or fixtures.

## Category Scope

- Authoring and Packaging plugins: Root SDK entrypoint, Focused SDK imports, Entrypoint discovery, Migration shims, Plugin manifest, Package metadata, Runtime compatibility, Validation feedback
- Bundled plugins: Bundled plugin listing, Bundled source overlays, Packaged bundled plugins, Generated plugin inventory, Bundled channel IDs
- Canvas plugin: Hosted Canvas and A2UI surfaces, Agent canvas tool, Node Canvas commands, Control UI embeds, Canvas documents, A2UI transport and snapshots
- Installing and running plugins: Plugin setup, Runtime activation, Enable and disable, Safe load failures, Dependency repair, Install update and uninstall
- Channel plugins: Inbound event handling, Outbound delivery, Ingress authorization, Destination resolution, Native approval prompts
- Provider and tool plugins: Provider plugins, Tool plugins, Model catalogs, Provider auth, Web search and fetch, Mixed plugins
- Plugin approvals: Approval requests, Native approval delivery, Same-chat fallbacks, Exec and plugin separation, Approval replay protection, Security helpers
- Publishing plugins: Install sources, ClawHub publishing, npm publishing, Compatibility signaling, Update and rollback expectations, Third-party publication rules
- Testing plugins: Test fixtures, Local test environment, Plugin runtime harness, Unit and integration scaffolds, Docker lifecycle suites, Smoke tests
