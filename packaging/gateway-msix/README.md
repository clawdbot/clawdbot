# OpenClaw Gateway MSIX

This subtree builds a Windows MSIX package containing:

- a .NET 10 NativeAOT bootstrapper exposed as the `openclaw-msix` app execution
  alias;
- a verified build of the current
  [`openclaw/openclaw`](https://github.com/openclaw/openclaw) checkout;
- the matching official Node.js runtime for x64 or ARM64.

The package is independent from the OpenClaw Companion application and uses a
separate `OpenClaw.Gateway` package identity. Both packages use the OpenClaw
Foundation publisher metadata already established by this repository.

## Bootstrap behavior

Launching `openclaw-msix` without arguments prepares the bundled gateway under
`%USERPROFILE%\.openclaw-msix\app`. It does not automatically start the
gateway. After preparation, use:

```powershell
openclaw-msix setup --classic --mode local --no-install-daemon
openclaw-msix gateway run
```

On later launches, the bootstrapper offers these choices:

- **C**: continue with fast verification (recommended);
- **R**: fully verify every prepared file and repair if needed.

When preparation is required, the host extracts into a temporary directory,
moves any existing prepared payload aside, and promotes the new payload only
after extraction and verification succeed. The previous payload is removed
after successful promotion, preserving rollback if preparation fails.

All explicit arguments are forwarded unchanged to the bundled OpenClaw CLI
after payload preparation. The host does not reserve, consume, reject, or
rewrite OpenClaw commands or options.

Every OpenClaw child process runs with
`OPENCLAW_SUPERVISOR_MODE=external` and `OPENCLAW_NO_AUTO_UPDATE=1`. This makes
the MSIX package the authoritative owner of Gateway code updates without
shadowing OpenClaw commands. OpenClaw itself is responsible for enforcing
those environment flags.

The distinct alias preserves access to an existing npm, pnpm, bun, installer,
or source-checkout `openclaw` command. Replacing that command requires a
separate migration and servicing decision.

## Selecting the OpenClaw revision

`.github\workflows\gateway-msix.yml` packages the exact checked-out commit.
Pull-request builds therefore test the PR head, while `main` builds package the
corresponding `main` commit. The resolved commit and package version are
recorded in `payload-metadata.json` and `msix-metadata.json`.

## Build and test

```powershell
dotnet restore .\packaging\gateway-msix\OpenClaw.Gateway.MSIX.slnx
dotnet test .\packaging\gateway-msix\OpenClaw.Gateway.MSIX.slnx `
  --configuration Release `
  --no-restore
```

`scripts\Build-Payload.ps1` turns an OpenClaw npm package into an
architecture-specific payload. `scripts\Build-MSIX.ps1` verifies that payload,
downloads and verifies the official Node.js runtime, then creates an unsigned
NativeAOT MSIX. `scripts\Build-LocalMSIX.ps1` can reuse a successful workflow
payload or a local payload directory.

Pull-request, push, and manual workflow runs publish unsigned x64 and ARM64
packages for validation. Official signing and release promotion are separate
release-owner concerns and are not enabled by the unsigned build workflow.

## Installed data

| Data | Default path |
|---|---|
| Prepared gateway files | `%USERPROFILE%\.openclaw-msix\app` |
| OpenClaw configuration and user state | `%USERPROFILE%\.openclaw` |
| Bootstrap diagnostics | `%LOCALAPPDATA%\Packages\<package-family>\LocalState\OpenClawGatewayMSIX\Logs\openclaw.log` |

The prepared gateway and OpenClaw user state are outside the immutable MSIX
installation directory. Updating or removing the MSIX does not automatically
delete those directories or stop a running Gateway. Use OpenClaw's documented
[`openclaw uninstall`](https://docs.openclaw.ai/install/uninstall) flow before
removing the MSIX. The prepared `%USERPROFILE%\.openclaw-msix` directory may
be removed manually after OpenClaw is stopped.

## Integrity and isolation boundary

Normal launches verify the immutable payload archive shipped in the MSIX, then
use the prepared payload marker to avoid re-hashing every extracted file.
Re-hashing the complete prepared payload on every launch was intentionally
rejected because it substantially delayed OpenClaw startup. The **R** bootstrap
action remains available for an explicit full verification and repair.

The prepared gateway directory is writable by the current user and is treated
as user-owned application state, not as a tamper-resistant trust boundary.
OpenClaw runs without elevation, so a user or another process already running
in that user's security context can modify those files. The external
supervisor and no-auto-update environment settings reduce unintended
self-updates, but do not protect the prepared payload from same-user
modification.

The longer-term design is to run the Gateway payload in a dedicated isolated
agent session rather than the interactive session where the human user is
logged in. This will provide a boundary similar in purpose to running the
Gateway in WSL, using the forthcoming isolated-session capabilities. That
isolation is not provided by the current MSIX implementation.
