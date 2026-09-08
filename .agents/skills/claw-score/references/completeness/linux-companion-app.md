# Linux companion app Completeness

Use this rubric when assigning category Completeness scores for the
`linux-app` surface.

## Category Scope

- App Distribution: Native app packages, Distro package targets, Official release metadata
- Gateway Connectivity: Local Gateway attach and status, Gateway pairing and auth, Remote mode, Local and remote resource boundaries
- Chat and Sessions: Quick Chat, Session-scoped transcript, Gateway chat transport
- Desktop Capabilities: Desktop integration, Secret storage, Sandbox/package posture, Linux native node identity, Host command execution, Desktop tools, Linux native Talk, Microphone capture, Native media permissions
- Status and Diagnostics: Native Linux app readiness, Gateway health/status display, Log/transcript opening, Doctor/repair affordances, Linux tray/status item, Runtime status row, Desktop-environment integration

## Surface-Specific Guidance

- Score the Tauri companion and its bundled Linux Node plugin as one operator-facing desktop product, while keeping the headless Gateway path on the separate `linux-host` surface.
- Treat `.deb` and AppImage release assets, checksum publication, and signed AppImage update metadata as the intended distribution workflow. Flatpak and Snap are not required for completeness.
- Count the Gateway-hosted Control UI and native Quick Chat as the supported chat/session experience. A second full native transcript window is not required.
- Keep native media completeness below Stable while Talk cannot capture the microphone inside the WebKitGTK shell, even though operators can use Talk in a regular browser.
- Do not require global shortcuts on Wayland; documented tray access is the supported fallback.
