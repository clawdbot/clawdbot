---
summary: "Install and configure Node.js for OpenClaw - version requirements, install options, and PATH troubleshooting"
title: "Node.js"
read_when:
  - "You need to install Node.js before installing OpenClaw"
  - "You installed OpenClaw but `openclaw` is command not found"
  - "npm install -g fails with permissions or PATH issues"
---

OpenClaw requires **Node 22.16 or newer**. **Node 24 is the default and recommended runtime** for installs, CI, and release workflows. Node 22 remains supported via the active LTS line. The [installer script](/install#alternative-install-methods) will detect and install Node automatically - this page is for when you want to set up Node yourself and make sure everything is wired up correctly (versions, PATH, global installs).

## Check your version

```bash
node -v
```

If this prints `v24.x.x` or higher, you're on the recommended default. If it prints `v22.16.x` or higher, you're on the supported Node 22 LTS path, but we still recommend upgrading to Node 24 when convenient. If Node isn't installed or the version is too old, pick an install method below.

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
fnm install 24
fnm use 24
```

  <Warning>
  Make sure your version manager is initialized in your shell startup file (`~/.zshrc` or `~/.bashrc`). If it isn't, `openclaw` may not be found in new terminal sessions because the PATH won't include Node's bin directory.
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
