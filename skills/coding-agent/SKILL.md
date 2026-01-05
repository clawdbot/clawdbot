---
name: coding-agent
description: Run Codex CLI, Claude Code, OpenCode, or Pi Coding Agent via background process for programmatic control.
metadata: {"clawdbot":{"emoji":"🧩","requires":{"anyBins":["claude","codex","opencode","pi"]}}}
---

# Coding Agent (background-first)

Use **bash background mode** for non-interactive coding work. For interactive coding sessions, use the **tmux** skill (always, except very simple one-shot prompts).

## The Pattern: workdir + background

```bash
# Create temp space for chats/scratch work
SCRATCH=$(mktemp -d)

# Start agent in target directory ("little box" - only sees relevant files)
bash workdir:$SCRATCH background:true command:"<agent command>"
# Or for project work:
bash workdir:~/project/folder background:true command:"<agent command>"
# Returns sessionId for tracking

# Monitor progress
process action:log sessionId:XXX

# Check if done  
process action:poll sessionId:XXX

# Send input (if agent asks a question)
process action:write sessionId:XXX data:"y"

# Kill if needed
process action:kill sessionId:XXX
```

**Why workdir matters:** Agent wakes up in a focused directory, doesn't wander off reading unrelated files (like your soul.md 😅).

---

## Codex CLI

**Model:** `gpt-5.2-codex` is the default (set in ~/.codex/config.toml)

### Building/Creating (use --full-auto or --yolo)
```bash
# --full-auto: sandboxed but auto-approves in workspace
bash workdir:~/project background:true command:"codex exec --full-auto \"Build a snake game with dark theme\""

# --yolo: NO sandbox, NO approvals (fastest, most dangerous)
bash workdir:~/project background:true command:"codex --yolo \"Build a snake game with dark theme\""

# Note: --yolo is a shortcut for --dangerously-bypass-approvals-and-sandbox
```

### Reviewing PRs (vanilla, no flags)

**⚠️ CRITICAL: Never review PRs in Clawdbot's own project folder!**
- Either use the project where the PR is submitted (if it's NOT ~/Projects/clawdbot)
- Or clone to a temp folder first

```bash
# Option 1: Review in the actual project (if NOT clawdbot)
bash workdir:~/Projects/some-other-repo background:true command:"codex review --base main"

# Option 2: Clone to temp folder for safe review (REQUIRED for clawdbot PRs!)
REVIEW_DIR=$(mktemp -d)
git clone https://github.com/clawdbot/clawdbot.git $REVIEW_DIR
cd $REVIEW_DIR && gh pr checkout 130
bash workdir:$REVIEW_DIR background:true command:"codex review --base origin/main"
# Clean up after: rm -rf $REVIEW_DIR

# Option 3: Use git worktree (keeps main intact)
git worktree add /tmp/pr-130-review pr-130-branch
bash workdir:/tmp/pr-130-review background:true command:"codex review --base main"
```

**Why?** Checking out branches in the running Clawdbot repo can break the live instance!

### Batch PR Reviews (parallel army!)
```bash
# Fetch all PR refs first
git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'

# Deploy the army - one Codex per PR!
bash workdir:~/project background:true command:"codex exec \"Review PR #86. git diff origin/main...origin/pr/86\""
bash workdir:~/project background:true command:"codex exec \"Review PR #87. git diff origin/main...origin/pr/87\""
bash workdir:~/project background:true command:"codex exec \"Review PR #95. git diff origin/main...origin/pr/95\""
# ... repeat for all PRs

# Monitor all
process action:list

# Get results and post to GitHub
process action:log sessionId:XXX
gh pr comment <PR#> --body "<review content>"
```

### Tips for PR Reviews
- **Fetch refs first:** `git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'`
- **Use git diff:** Tell Codex to use `git diff origin/main...origin/pr/XX`
- **Don't checkout:** Multiple parallel reviews = don't let them change branches
- **Post results:** Use `gh pr comment` to post reviews to GitHub

---

## Claude Code

```bash
bash workdir:~/project background:true command:"claude \"Your task\""
```

---

## OpenCode

```bash
bash workdir:~/project background:true command:"opencode run \"Your task\""
```

---

## Pi Coding Agent

```bash
# Install: npm install -g @mariozechner/pi-coding-agent
bash workdir:~/project background:true command:"pi \"Your task\""
```

---

## Pi flags (common)

- `--print` / `-p`: non-interactive; runs prompt and exits.
- `--provider <name>`: pick provider (default: google).
- `--model <id>`: pick model (default: gemini-2.5-flash).
- `--api-key <key>`: override API key (defaults to env vars).

Examples:

```bash
# Set provider + model, non-interactive
bash workdir:~/project background:true command:"pi --provider openai --model gpt-4o-mini -p \"Summarize src/\""
```

---

## tmux (interactive sessions)

Use the tmux skill for interactive coding sessions (always, except very simple one-shot prompts). Prefer bash background mode for non-interactive runs.

---

## Parallel Issue Fixing with git worktrees + tmux

For fixing multiple issues in parallel, use git worktrees (isolated branches) + tmux sessions:

```bash
# 1. Clone repo to temp location
cd /tmp && git clone git@github.com:user/repo.git repo-worktrees
cd repo-worktrees

# 2. Create worktrees for each issue (isolated branches!)
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main

# 3. Set up tmux sessions
SOCKET="${TMPDIR:-/tmp}/codex-fixes.sock"
tmux -S "$SOCKET" new-session -d -s fix-78
tmux -S "$SOCKET" new-session -d -s fix-99

# 4. Launch Codex in each (after pnpm install!)
tmux -S "$SOCKET" send-keys -t fix-78 "cd /tmp/issue-78 && pnpm install && codex --yolo 'Fix issue #78: <description>. Commit and push.'" Enter
tmux -S "$SOCKET" send-keys -t fix-99 "cd /tmp/issue-99 && pnpm install && codex --yolo 'Fix issue #99: <description>. Commit and push.'" Enter

# 5. Monitor progress
tmux -S "$SOCKET" capture-pane -p -t fix-78 -S -30
tmux -S "$SOCKET" capture-pane -p -t fix-99 -S -30

# 6. Check if done (prompt returned)
tmux -S "$SOCKET" capture-pane -p -t fix-78 -S -3 | grep -q "❯" && echo "Done!"

# 7. Create PRs after fixes
cd /tmp/issue-78 && git push -u origin fix/issue-78
gh pr create --repo user/repo --head fix/issue-78 --title "fix: ..." --body "..."

# 8. Cleanup
tmux -S "$SOCKET" kill-server
git worktree remove /tmp/issue-78
git worktree remove /tmp/issue-99
```

**Why worktrees?** Each Codex works in isolated branch, no conflicts. Can run 5+ parallel fixes!

**Why tmux over bash background?** Codex is interactive — needs TTY for proper output. tmux provides persistent sessions with full history capture.

---

## ⚠️ Rules

1. **Respect tool choice** — if user asks for Codex, use Codex. NEVER offer to build it yourself!
2. **Be patient** — don't kill sessions because they're "slow"
3. **Monitor with process:log** — check progress without interfering
4. **--full-auto for building** — auto-approves changes
5. **vanilla for reviewing** — no special flags needed
6. **Parallel is OK** — run many Codex processes at once for batch work
7. **NEVER start Codex in ~/clawd/** — it'll read your soul docs and get weird ideas about the org chart! Use the target project dir or /tmp for blank slate chats
8. **NEVER checkout branches in ~/Projects/clawdbot/** — that's the LIVE Clawdbot instance! Clone to /tmp or use git worktree for PR reviews

---

## PR Template (The Razor Standard)

When submitting PRs to external repos, use this format for quality & maintainer-friendliness:

````markdown
## Original Prompt
[Exact request/problem statement]

## What this does
[High-level description]

**Features:**
- [Key feature 1]
- [Key feature 2]

**Example usage:**
```bash
# Example
command example
```

## Feature intent (maintainer-friendly)
[Why useful, how it fits, workflows it enables]

## Prompt history (timestamped)
- YYYY-MM-DD HH:MM UTC: [Step 1]
- YYYY-MM-DD HH:MM UTC: [Step 2]

## How I tested
**Manual verification:**
1. [Test step] - Output: `[result]`
2. [Test step] - Result: [result]

**Files tested:**
- [Detail]
- [Edge cases]

## Session logs (implementation)
- [What was researched]
- [What was discovered]
- [Time spent]

## Implementation details
**New files:**
- `path/file.ts` - [description]

**Modified files:**
- `path/file.ts` - [change]

**Technical notes:**
- [Detail 1]
- [Detail 2]

---
*Submitted by Razor 🥷 - Mariano's AI agent*
````

**Key principles:**
1. Human-written description (no AI slop)
2. Feature intent for maintainers
3. Timestamped prompt history
4. Session logs if using Codex/agent

**Example:** https://github.com/steipete/bird/pull/22
