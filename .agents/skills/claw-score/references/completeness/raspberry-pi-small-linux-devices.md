# Raspberry Pi / small Linux devices Completeness

Use this rubric when assigning category Completeness scores for the
`raspberry-pi-small-linux-devices` surface.

## Category Scope

- Setup and Compatibility: Hardware and 64-bit OS requirements, Node runtime setup, OpenClaw install and onboarding, First-run verification, Supported Pi model selection, 64-bit ARM boundary, Unsupported device guidance, Slow-device caveats, npm/pnpm/Bun install modes, Installer architecture detection, Optional ARM binary checks, Fallback/build guidance
- Remote Access and Auth: Headless API-key auth, Gateway shared-secret auth, Device pairing approvals, SecretRef handling, Token drift recovery, SSH tunnel dashboard access, Tailscale Serve/Funnel, Loopback/non-loopback exposure controls, Authenticated Control UI access
- Gateway Runtime: Always-on Gateway process, Cloud model configuration, Channel startup, Gateway health/status, User service install, linger/boot persistence, Service drop-ins, Restart tuning, Status/log inspection, Backup/restore
- Performance and Diagnostics: Swap and low-RAM tuning, USB SSD guidance, Compile cache/no-respawn settings, OOM/performance troubleshooting, Diagnostics bundles
