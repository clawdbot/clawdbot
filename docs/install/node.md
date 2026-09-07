---
summary: "Install and configure Node.js for OpenClaw - version requirements, install options, and PATH troubleshooting"
title: "Node.js"
read_when:
  - "You need to install Node.js before installing OpenClaw"
  - "You installed OpenClaw but `openclaw` is command not found"
  - "npm install -g fails with permissions or PATH issues"
---

OpenClaw requires **Node 24.16+ or Node 26.1+** with a WAL-reset-safe linked SQLite library. **Node 26 is the recommended runtime** — it starts the Gateway noticeably faster and uses less memory than Node 24. The installer provisions Node 26 on macOS and the supported Node 24 LTS line on Linux when Node is missing; CI and release workflows also pin Node 24. On RPM-based Linux, the installer preserves a supported distro-owned Node package that links unsafe SQLite and uses a user-space Node runtime for OpenClaw instead. Node 22, 23, and 25 are unsupported. The [installer script](/install#recommended-installer-script) detects and installs Node automatically — use this page when you want to set up Node yourself (versions, PATH, global installs).

## Check your version

```bash
node -v
```

`v26.1.0` or newer is the recommended default. `v24.16.0` or newer 24.x is also supported and is the LTS line used by CI. Node 22, 23, 25, Node 24 before 24.16.0, and Node 26 before 26.1.0 are unsupported. If Node is missing or outside this range, pick an install method below.

These floors preserve embedded NUL characters when `node:sqlite` reads TEXT values. Older Node bindings can silently shorten stored identities even when the linked SQLite version is WAL-reset-safe. Upgrade Node before updating OpenClaw. The rootless installer already provisions Node 24.19.0 on supported platforms.

Official Node 24+ binaries require macOS 13.5 or newer and do not provide Linux ARMv7 builds. On compatible ARM hardware, use a 64-bit operating system; otherwise use another supported host. The macOS companion app has its own [platform requirements](/platforms/macos).

## Install Node

<Tabs>
  <Tab title="macOS">
    **Homebrew** (recommended):

    ```bash
    brew install node
    ```

    Or download the macOS installer from [nodejs.org](https://nodejs.org/).

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian:**

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    **Fedora / RHEL:**

    ```bash
    sudo dnf install nodejs
    ```

    Some distro Node packages link the system SQLite library. The recommended OpenClaw installer checks the effective Node and SQLite combination and automatically uses a user-space Node runtime when the distro build is unsafe; it does not remove the distro package.

    Or use a version manager (see below).

  </Tab>
  <Tab title="Windows">
    **winget** (recommended):

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **Chocolatey:**

    ```powershell
    choco install nodejs-lts
    ```

    Or download the Windows installer from [nodejs.org](https://nodejs.org/).

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  Version managers let you switch between Node versions easily. Popular options:

- [**fnm**](https://github.com/Schniz/fnm) - fast, cross-platform
- [**nvm**](https://github.com/nvm-sh/nvm) - widely used on macOS/Linux
- [**mise**](https://mise.jdx.dev/) - polyglot (Node, Python, Ruby, etc.)

Example with fnm:

```bash
fnm install 26
fnm use 26
```

  <Warning>
  Initialize your version manager in your shell startup file (`~/.zshrc` or `~/.bashrc`). If you skip this, `openclaw` may not be found in new terminal sessions because PATH won't include Node's bin directory.
  </Warning>
</Accordion>

## Troubleshooting

### `openclaw: command not found`

This almost always means npm's global bin directory isn't on your PATH.

<Steps>
  <Step title="Find your global npm prefix">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="Check if it's on your PATH">
    ```bash
    echo "$PATH"
    ```

    Look for `<npm-prefix>/bin` (macOS/Linux) or `<npm-prefix>` (Windows) in the output.

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        Add to `~/.zshrc` or `~/.bashrc`:

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        Then open a new terminal (or run `rehash` in zsh / `hash -r` in bash).
      </Tab>
      <Tab title="Windows">
        Add the output of `npm prefix -g` to your system PATH via Settings → System → Environment Variables.
      </Tab>
    </Tabs>

  </Step>
</Steps>

### Permission errors on `npm install -g` (Linux)

If you see `EACCES` errors, switch npm's global prefix to a user-writable directory:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Add the `export PATH=...` line to your `~/.bashrc` or `~/.zshrc` to make it permanent.

## Related

- [Install Overview](/install) - all installation methods
- [Updating](/install/updating) - keeping OpenClaw up to date
- [Getting Started](/start/getting-started) - first steps after install
