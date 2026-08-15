# CodexBar CLI quick ref (usage + cost)

## Install

- macOS and Linux Homebrew formula: `brew install steipete/tap/codexbar`
- Linux AUR package: `yay -S codexbar-cli`
- macOS and Linux tarballs: [CodexBar releases](https://github.com/steipete/CodexBar/releases)
- macOS app: Preferences -> Advanced -> Install CLI

## Commands

- Usage snapshot (web/cli sources):
  - codexbar usage --format json --pretty
  - codexbar --provider all --format json
- Local cost usage (Codex + Claude only):
  - codexbar cost --format json --pretty
  - codexbar cost --provider codex|claude --format json

## Cost JSON fields

The payload is an array (one per provider).

- provider, source, updatedAt
- sessionTokens, sessionCostUSD
- last30DaysTokens, last30DaysCostUSD
- daily[]: date, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalTokens, totalCost, modelsUsed, modelBreakdowns[]
- modelBreakdowns[]: modelName, cost
- totals: totalInputTokens, totalOutputTokens, cacheReadTokens, cacheCreationTokens, totalTokens, totalCost

## Notes

- Cost usage is local-only. It reads JSONL logs under:
  - Codex: ~/.codex/sessions/\*_/_.jsonl
  - Claude: ~/.config/claude/projects/**/\*.jsonl or ~/.claude/projects/**/\*.jsonl
- If web usage is required (non-local), use codexbar usage (not cost).
