# macOS Gateway host Completeness

Use this rubric when assigning category Completeness scores for the
`macos-gateway-host` surface.

## Category Scope

- CLI Setup: Hosted installer, Node 24 recommendation, App-triggered CLI install, Shell PATH and version-manager drift
- Local Gateway Integration: App local/remote connection mode, App-managed Gateway LaunchAgent install/restart/uninstall, CLI install detection, Attach-to-existing local Gateway compatibility, Gateway endpoint, gateway.mode=local configuration, Loopback bind, Local app endpoint resolution, Bonjour discovery
- Remote Gateway Mode: macOS app "Remote over SSH", SSH tunnel setup, Tailscale MagicDNS, Remote endpoint token/password/TLS fingerprint, Local node host startup
- Gateway Service Lifecycle: Per-user Gateway LaunchAgent install, launchctl bootstrap, LaunchAgent labels, Gateway token/env handling, App-managed LaunchAgent handoff, openclaw update package/git handoff, Managed service refresh, Stale updater launchd job detection, openclaw uninstall, Stranded service recovery
- Diagnostics and Observability: LaunchAgent log paths, openclaw gateway status --deep, Gateway silently stops responding, Stale updater jobs
- Permissions and Native Capabilities: macOS TCC permission prompts/status, Native node capability exposure, system.run policy, Permission-driven support
- Profiles and Isolation: Profile-specific LaunchAgent labels, Profile-specific state/config/workspace roots, Derived ports, Rescue bot setup, Extra Gateway process detection
