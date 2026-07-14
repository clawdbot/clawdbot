---
summary: "How the installer scripts work (install.sh, install-cli.sh, install.ps1), flags, and automation"
read_when:
  - You want to understand `openclaw.ai/install.sh`
  - You want to automate installs (CI / headless)
  - You want to install from a GitHub checkout
title: "Installer internals"
---

OpenClaw ships three installer scripts, served from `openclaw.ai`.

| Script                             | Platform             | What it does                                                                                   |
| ---------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL  | Installs Node if needed, installs OpenClaw via npm (default) or git, can run onboarding.       |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL  | Installs Node + OpenClaw into a local prefix (`~/.openclaw`) via npm or git. No root required. |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Installs Node if needed, installs OpenClaw via npm (default) or git, can run onboarding.       |

All three support Node **22.22.3+, 24.15+, or 25.9+**; Node 24 is the default target for fresh installs.

## Quick commands

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help
    ```

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help
    ```

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```

  </Tab>
</Tabs>

<Note>
If install succeeds but `openclaw` is not found in a new terminal, see [Node.js troubleshooting](/install/node#troubleshooting).
</Note>

---

<a id="installsh"></a>

## install.sh

<Tip>
Recommended for most interactive installs on macOS/Linux/WSL.
</Tip>

### Flow (install.sh)

<Steps>
  <Step title="Detect OS">
    Supports macOS and Linux (including WSL).
  </Step>
  <Step title="Ensure Node.js 24 by default">
    Checks Node version and installs Node 24 if needed (Homebrew on macOS, NodeSource setup scripts on Linux apt/dnf/yum). On macOS, Homebrew is installed only when the installer needs it for Node or Git. Node 22.22.3+, Node 24.15+, and Node 25.9+ are supported; Node 23 is unsupported.
    On Alpine/musl Linux, the installer uses apk packages instead of NodeSource and verifies the actual linked SQLite version. Current stable Alpine package streams can provide a new-enough Node with vulnerable system SQLite; when that happens, use an official `node:24-alpine` container or a glibc-based host instead.
  </Step>
  <Step title="Ensure Git">
    Installs Git if missing using the detected package manager, including Homebrew on macOS and apk on Alpine.
  </Step>
  <Step title="Install OpenClaw">
    - `npm` method (default): global npm install
    - `git` method: clone/update repo, install deps with pnpm, build, then install wrapper at `~/.local/bin/openclaw`

  </Step>
  <Step title="Post-install tasks">
    - Resolves the just-installed `openclaw` binary for follow-up commands
    - For an unconfigured install, starts onboarding before doctor or gateway probes. With `--no-onboard` or no TTY, it prints the command to finish setup later.
    - For a configured install, refreshes and restarts a loaded gateway service best-effort and runs doctor. Upgrades update plugins when possible, or print the manual command in a headless prompt-enabled run.
    - When `--verify` runs, it checks the installed version and checks gateway health only after configuration exists.

  </Step>
</Steps>

### Source checkout detection

If run inside an OpenClaw checkout (`package.json` + `pnpm-workspace.yaml`), the script offers:

- use checkout (`git`), or
- use global install (`npm`)

If no TTY is available and no install method is set, it defaults to `npm` and warns.

The script exits with code `2` for invalid method selection or invalid `--install-method` values.

### Examples (install.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Skip onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Git install">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="GitHub main checkout">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git --version main
    ```
  </Tab>
  <Tab title="Dry run">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
  <Tab title="Verify after install">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard --verify
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                                    | Description                                                             |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `--install-method \| --method npm\|git` | Choose install method (default: `npm`)                                  |
| `--npm`                                 | Shortcut for npm method                                                 |
| `--git \| --github`                     | Shortcut for git method                                                 |
| `--version <version\|dist-tag\|spec>`   | npm version, dist-tag, or package spec (default: `latest`)              |
| `--beta`                                | Use beta dist-tag if available, else fall back to `latest`              |
| `--git-dir \| --dir <path>`             | Checkout directory (default: `~/openclaw`)                              |
| `--no-git-update`                       | Skip `git pull` for existing checkout                                   |
| `--no-prompt`                           | Disable prompts                                                         |
| `--no-onboard`                          | Skip onboarding                                                         |
| `--onboard`                             | Enable onboarding                                                       |
| `--verify`                              | Run a post-install smoke verify (`--version`, gateway health if loaded) |
| `--dry-run`                             | Print actions without applying changes                                  |
| `--verbose`                             | Enable debug output (`set -x`, npm notice-level logs)                   |
| `--help \| -h`                          | Show usage                                                              |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                          | Description                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `OPENCLAW_INSTALL_METHOD=git\|npm`                | Install method                                                     |
| `OPENCLAW_VERSION=latest\|next\|<semver>\|<spec>` | npm version, dist-tag, or package spec                             |
| `OPENCLAW_BETA=0\|1`                              | Use beta if available                                              |
| `OPENCLAW_HOME=<path>`                            | Base directory for OpenClaw state and default git/onboarding paths |
| `OPENCLAW_GIT_DIR=<path>`                         | Checkout directory                                                 |
| `OPENCLAW_GIT_UPDATE=0\|1`                        | Toggle git updates                                                 |
| `OPENCLAW_NO_PROMPT=1`                            | Disable prompts                                                    |
| `OPENCLAW_VERIFY_INSTALL=1`                       | Run the post-install smoke verify                                  |
| `OPENCLAW_NO_ONBOARD=1`                           | Skip onboarding                                                    |
| `OPENCLAW_DRY_RUN=1`                              | Dry run mode                                                       |
| `OPENCLAW_VERBOSE=1`                              | Debug mode                                                         |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice`       | npm log level (default: `error`, hides npm deprecation noise)      |

  </Accordion>
</AccordionGroup>

---

<a id="install-clish"></a>

## install-cli.sh

<Info>
Designed for environments where you want everything under a local prefix
(default `~/.openclaw`) and no system Node dependency. Supports npm installs
by default, plus git-checkout installs under the same prefix flow.
</Info>

### Flow (install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    Downloads a pinned supported Node LTS tarball (the version is embedded in the script and updated independently, default `24.15.0`) to `<prefix>/tools/node-v<version>` and verifies SHA-256.
    Linux ARMv7 uses Node `22.22.3` because official Node 24+ ARMv7 binaries are unavailable.
    On Alpine/musl Linux, where Node does not publish compatible tarballs for the pinned runtime, installs `nodejs` and `npm` with `apk`, then verifies both Node and the actual linked SQLite library. Current stable Alpine package streams may still link vulnerable SQLite even with a new-enough Node; use an official `node:24-alpine` container or a glibc-based host when the safety check rejects the package.
  </Step>
  <Step title="Ensure Git">
    If Git is missing, attempts install via apt/dnf/yum/apk on Linux or Homebrew on macOS.
  </Step>
  <Step title="Install OpenClaw under prefix">
    - `npm` method (default): installs under the prefix with npm, then writes wrapper to `<prefix>/bin/openclaw`
    - `git` method: clones/updates a checkout (default `~/openclaw`) and still writes the wrapper to `<prefix>/bin/openclaw`

  </Step>
  <Step title="Refresh loaded gateway service">
    If a gateway service is already loaded from that same prefix, the script runs
    `openclaw gateway install --force`, then `openclaw gateway restart`, and
    probes gateway health best-effort.
  </Step>
</Steps>

### Examples (install-cli.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="Custom prefix + version">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="Git install">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --install-method git --git-dir ~/openclaw
    ```
  </Tab>
  <Tab title="Automation JSON output">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="Run onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                                    | Description                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `--prefix <path>`                       | Install prefix (default: `~/.openclaw`)                                         |
| `--install-method \| --method npm\|git` | Choose install method (default: `npm`)                                          |
| `--npm`                                 | Shortcut for npm method                                                         |
| `--git \| --github`                     | Shortcut for git method                                                         |
| `--git-dir \| --dir <path>`             | Git checkout directory (default: `~/openclaw`)                                  |
| `--version <ver>`                       | OpenClaw version or dist-tag (default: `latest`)                                |
| `--node-version <ver>`                  | Node version (default: `24.15.0`; `22.22.3` on Linux ARMv7)                     |
| `--json`                                | Emit NDJSON events                                                              |
| `--onboard`                             | Run `openclaw onboard` after install                                            |
| `--no-onboard`                          | Skip onboarding (default)                                                       |
| `--set-npm-prefix`                      | On Linux, force npm prefix to `~/.npm-global` if current prefix is not writable |
| `--help \| -h`                          | Show usage                                                                      |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                    | Description                                                        |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `OPENCLAW_PREFIX=<path>`                    | Install prefix                                                     |
| `OPENCLAW_INSTALL_METHOD=git\|npm`          | Install method                                                     |
| `OPENCLAW_VERSION=<ver>`                    | OpenClaw version or dist-tag                                       |
| `OPENCLAW_NODE_VERSION=<ver>`               | Node version                                                       |
| `OPENCLAW_HOME=<path>`                      | Base directory for OpenClaw state and default git/onboarding paths |
| `OPENCLAW_GIT_DIR=<path>`                   | Git checkout directory for git installs                            |
| `OPENCLAW_GIT_UPDATE=0\|1`                  | Toggle git updates for existing checkouts                          |
| `OPENCLAW_NO_ONBOARD=1`                     | Skip onboarding                                                    |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm log level (default: `error`)                                   |

  </Accordion>
</AccordionGroup>

<Note>
`openclaw@main` and other GitHub source specs are not valid `--version` targets for npm installs. Use `--install-method git --version main` instead.
</Note>

---

<a id="installps1"></a>

## install.ps1

### Flow (install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    Requires PowerShell 5+.
  </Step>
  <Step title="Ensure Node.js 24 by default">
    If missing, attempts install via winget, then Chocolatey, then Scoop. If no package manager is available, the script downloads the official Node.js 24 Windows zip into `%LOCALAPPDATA%\OpenClaw\deps\portable-node` and adds it to the current process and user PATH. Node 22.22.3+, Node 24.15+, and Node 25.9+ are supported; Node 23 is unsupported.
  </Step>
  <Step title="Install OpenClaw">
    - `npm` method (default): global npm install using the selected `-Tag`, launched from a writable installer temp directory so shells opened in protected folders such as `C:\` still work
    - `git` method: clone/update repo, install/build with pnpm, and install wrapper at `%USERPROFILE%\.local\bin\openclaw.cmd`. If Git is missing, the script bootstraps user-local MinGit under `%LOCALAPPDATA%\OpenClaw\deps\portable-git` and adds it to the current process and user PATH.

  </Step>
  <Step title="Post-install tasks">
    - Adds needed bin directory to user PATH when possible
    - Refreshes a loaded gateway service best-effort (`openclaw gateway install --force`, then restart)
    - Runs `openclaw doctor --non-interactive` on upgrades and git installs (best effort)

  </Step>
  <Step title="Handle failures">
    `iwr ... | iex` and scriptblock installs report a terminating error without closing the current PowerShell session. Direct `powershell -File` / `pwsh -File` installs still exit non-zero for automation.
  </Step>
</Steps>

### Examples (install.ps1)

<Tabs>
  <Tab title="Default">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Git install">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="GitHub main checkout">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -Tag main
    ```
  </Tab>
  <Tab title="Custom git directory">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="Dry run">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                        | Description                                                |
| --------------------------- | ---------------------------------------------------------- |
| `-InstallMethod npm\|git`   | Install method (default: `npm`)                            |
| `-Tag <tag\|version\|spec>` | npm dist-tag, version, or package spec (default: `latest`) |
| `-GitDir <path>`            | Checkout directory (default: `%USERPROFILE%\openclaw`)     |
| `-NoOnboard`                | Skip onboarding                                            |
| `-NoGitUpdate`              | Skip `git pull`                                            |
| `-DryRun`                   | Print actions only                                         |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                           | Description        |
| ---------------------------------- | ------------------ |
| `OPENCLAW_INSTALL_METHOD=git\|npm` | Install method     |
| `OPENCLAW_GIT_DIR=<path>`          | Checkout directory |
| `OPENCLAW_NO_ONBOARD=1`            | Skip onboarding    |
| `OPENCLAW_GIT_UPDATE=0`            | Disable git pull   |
| `OPENCLAW_DRY_RUN=1`               | Dry run mode       |

  </Accordion>
</AccordionGroup>

<Note>
If `-InstallMethod git` is used and Git is missing, the script tries a user-local MinGit bootstrap before printing the Git for Windows link.
</Note>

---

## CI and automation

Use non-interactive flags/env vars for predictable runs.

<Tabs>
  <Tab title="install.sh (non-interactive npm)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (non-interactive git)">
    ```bash
    OPENCLAW_INSTALL_METHOD=git OPENCLAW_NO_PROMPT=1 \
      curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="install-cli.sh (JSON)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="install.ps1 (skip onboarding)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## Troubleshooting

<AccordionGroup>
  <Accordion title="Why is Git required?">
    Git is required for the `git` install method. For `npm` installs, Git is still checked/installed to avoid `spawn git ENOENT` failures when dependencies use git URLs.
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    Some Linux setups point npm's global prefix to root-owned paths. `install.sh` can switch the prefix to `~/.npm-global` and append PATH exports to shell rc files (when those files exist).
  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Rerun the installer so it can bootstrap user-local MinGit, or install Git for Windows and reopen PowerShell.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    Run `npm config get prefix` and add that directory to your user PATH (no `\bin` suffix needed on Windows), then reopen PowerShell.
  </Accordion>

  <Accordion title="Windows: how to get verbose installer output">
    `install.ps1` does not expose a `-Verbose` switch.
    Use PowerShell tracing for script-level diagnostics:

    ```powershell
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```

  </Accordion>

  <Accordion title="openclaw not found after install">
    Usually a PATH issue. See [Node.js troubleshooting](/install/node#troubleshooting).
  </Accordion>
</AccordionGroup>

## Related

- [Install overview](/install)
- [Updating](/install/updating)
- [Uninstall](/install/uninstall)
