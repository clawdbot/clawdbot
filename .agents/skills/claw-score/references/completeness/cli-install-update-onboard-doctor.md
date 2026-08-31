# CLI Surface Completeness

Use this rubric when assigning category Completeness scores for the
`cli-install-update-onboard-doctor` surface.

## Surface-Specific Scoring Questions

For each category, ask:

- Can a normal operator complete the job end to end from the CLI?
- Are the expected environments represented where they matter for the category,
  such as local installs, remote gateway use, supervised services, or
  Windows/WSL2?
- Are the main lifecycle stages present where relevant: setup, inspection,
  change, repair, and upgrade?
- Are common recovery and troubleshooting branches present, or does the
  workflow dead-end after the happy path?
- Are major documented operator expectations still unimplemented?

## Surface-Specific Guidance

Variation from the default completeness process:

- Completeness is the CLI operator journey for installation, onboarding, configuration, repair, and upgrade across expected environments and recovery branches.
- Score the CLI against the full operator journey, not only installation or the happy path.
- Repair, migration, remote, and platform-specific branches are expected where a category exposes them.
- For Windows and WSL2, score against the intended supported experience rather than parity with macOS/Linux internals.

## Category Scope

- CLI Setup: Installer scripts, Local prefix install, Package-manager installs, Supported Node runtime, Source checkout install, CLI entrypoint
- Onboarding and Auth Setup: Guided onboarding, Targeted reconfiguration, Auth choices, Gateway auth storage, Remote onboarding
- Plugin and Channel Setup: Channel picker, Plugin install sources, Channel account setup, Post-setup probes, Remote gateway caveat
- Gateway Service Management: Foreground gateway runs, Service install and control, Service auth wiring, Drift and reinstall recovery, Service health checks
- CLI Observability: Status snapshots, Health snapshots, Remote log tailing, Diagnostics export, Support-safe redaction
- Doctor: Interactive repair, Config migration, Auth and SecretRef checks, Plugin validation and repair, Lint and JSON findings, Extra gateway discovery, Supervisor drift repair, Port and startup diagnosis, Runtime path checks, Restart guidance
- Updates and Upgrades: Update channels, Install-kind switching, Managed gateway restart, Update status and RPC, Plugin convergence
