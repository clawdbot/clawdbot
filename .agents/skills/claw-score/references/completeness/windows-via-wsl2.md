# Windows via WSL2 Completeness

Use this rubric when assigning category Completeness scores for the
`windows-via-wsl2` surface.

## Category Scope

- WSL Setup and Updates: WSL2 + Ubuntu installation, Node runtime, Linux install flow inside WSL2, WSL2 runtime boundary, WSL2 network-family requirements, Source install and build inside WSL2, openclaw update, npm/pnpm/git package-root, Managed systemd Gateway restart, Service metadata refresh, Package-manager caveats
- Gateway Service Lifecycle: Onboarded systemd install, Gateway service install, systemd user unit rendering, WSL-aware systemd unavailable hints, Doctor service repair, WSL user-service linger, Systemd availability after Windows boot, Windows startup task for WSL, Verification before Windows sign-in, Clear expectations around PC power
- Gateway Access and Exposure: Gateway token/password auth, Provider credentials, Gateway auth SecretRefs, Remote URL credential precedence, WSL virtual network, Windows portproxy setup, Windows Firewall rules, Reachable Gateway URLs, Loopback and LAN exposure, WSL2 IPv4 networking, Tailscale remote access
- Diagnostics and Repair: openclaw doctor, openclaw status, openclaw logs, SecretRef, WSL/systemd unavailable hints, Operator repair guidance after WSL2 service
- Browser and Control UI: WSL2 Gateway with Windows browser, Windows Control UI URL, Raw remote CDP to Windows Chrome, Host-local Chrome MCP, Browser profile cdpUrl, Layered diagnostics
