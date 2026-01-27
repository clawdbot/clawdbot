---
title: "Node.js + npm (PATH sanity)"
summary: "Node.js + npm install sanity: versions, PATH, and global installs"
read_when:
  - "You installed Moltbot but `moltbot` is “command not found”"
  - "You’re setting up Node.js/npm on a new machine"
  - "npm install -g ... fails with permissions or PATH issues"
---

# Node.js + npm (PATH sanity)

Moltbot’s runtime baseline is **Node 22+**.

If you can run `npm install -g moltbot@latest` but later see `moltbot: command not found`, it’s almost always a **PATH** issue: the directory where npm puts global binaries isn’t on your shell’s PATH.

## Quick diagnosis

Run:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

If `$(npm prefix -g)/bin` (macOS/Linux) or `$(npm prefix -g)` (Windows) is **not** present inside `echo "$PATH"`, your shell can’t find global npm binaries (including `moltbot`).

## Fix: put npm’s global bin dir on PATH

1) Find your global npm prefix:

```bash
npm prefix -g
```

2) Add the global npm bin directory to your shell startup file:

- zsh: `~/.zshrc`
- bash: `~/.bashrc`

Example (replace the path with your `npm prefix -g` output):

```bash
# macOS / Linux
export PATH="/path/from/npm/prefix/bin:$PATH"
```

Then open a **new terminal** (or run `rehash` in zsh / `hash -r` in bash).

On Windows, add the output of `npm prefix -g` to your PATH.

## Fix: avoid `sudo npm install -g` / permission errors (Linux)

If `npm install -g ...` fails with `EACCES`, switch npm’s global prefix to a user-writable directory:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Persist the `export PATH=...` line in your shell startup file.

## Recommended Node install options

You’ll have the fewest surprises if Node/npm are installed in a way that:

- keeps Node updated (22+)
- makes the global npm bin dir stable and on PATH in new shells

Common choices:

- macOS: Homebrew (`brew install node`) or a version manager
- Linux: your preferred version manager, or a distro-supported install that provides Node 22+
- Windows: official Node installer, `winget`, or a Windows Node version manager

If you use a version manager (nvm/fnm/asdf/etc), ensure it’s initialized in the shell you use day-to-day (zsh vs bash) so the PATH it sets is present when you run installers.
