---
name: food-order
description: Reorder Foodora orders + track ETA/status with ordercli. Never confirm without explicit user approval. Triggers: order food, reorder, track ETA.
homepage: https://ordercli.sh
metadata: {"moltbot":{"emoji":"🥡","requires":{"bins":["ordercli"]},"install":[{"id":"go","kind":"go","module":"github.com/steipete/ordercli/cmd/ordercli@latest","bins":["ordercli"],"label":"Install ordercli (go)"}]}}
---

# Food order (Foodora via ordercli)

Goal: reorder a previous Foodora order safely (preview first; confirm only on explicit user “yes/confirm/place the order”).

Hard safety rules
- Never run `ordercli foodora reorder ... --confirm` unless user explicitly confirms placing the order.
- Prefer preview-only steps first; show what will happen; ask for confirmation.
- If user is unsure: stop at preview and ask questions.

Setup (once)
- Country: `ordercli foodora countries` → `ordercli foodora config set --country AT`
- Login (password): `ordercli foodora login --email you@example.com --password-stdin`
- Login (no password, preferred): `ordercli foodora session chrome --url https://www.foodora.at/ --profile "Default"`

Find what to reorder
- Recent list: `ordercli foodora history --limit 10`
- Details: `ordercli foodora history show <orderCode>`
- If needed (machine-readable): `ordercli foodora history show <orderCode> --json`

Preview reorder (no cart changes)
- `ordercli foodora reorder <orderCode>`

Place reorder (cart change; explicit confirmation required)
- Confirm first, then run: `ordercli foodora reorder <orderCode> --confirm`
- Multiple addresses? Ask user for the right `--address-id` (take from their Foodora account / prior order data) and run:
  - `ordercli foodora reorder <orderCode> --confirm --address-id <id>`

Track the order
- ETA/status (active list): `ordercli foodora orders`
- Live updates: `ordercli foodora orders --watch`
- Single order detail: `ordercli foodora order <orderCode>`

Debug / safe testing
- Use a throwaway config: `ordercli --config /tmp/ordercli.json ...`
