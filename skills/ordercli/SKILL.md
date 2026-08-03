---
name: ordercli
description: "Foodora-only CLI for checking past orders and active order status (Deliveroo WIP)."
homepage: https://ordercli.sh
metadata:
  {
    "openclaw":
      {
        "emoji": "🛵",
        "requires": { "bins": ["ordercli"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/ordercli",
              "bins": ["ordercli"],
              "label": "Install ordercli (brew)",
            },
            {
              "id": "go",
              "kind": "go",
              "module": "github.com/steipete/ordercli/cmd/ordercli@latest",
              "bins": ["ordercli"],
              "label": "Install ordercli (go)",
            },
          ],
      },
  }
---

# ordercli

Use `ordercli` to check past orders and track active order status (Foodora only right now).

Quick start (Foodora)

- `ordercli foodora countries`
- `ordercli foodora config set --country AT`
- `ordercli foodora login --email you@example.com --password-stdin`
- `ordercli foodora orders`
- `ordercli foodora history --limit 20`
- `ordercli foodora history show <orderCode>`

Orders

- Active list (arrival/status): `ordercli foodora orders`
- Watch: `ordercli foodora orders --watch`
- Active order detail: `ordercli foodora order <orderCode>`
- History detail JSON: `ordercli foodora history show <orderCode> --json`

Reorder (adds to cart)

- Preview only: `ordercli foodora reorder <orderCode>`
- Confirm after showing restaurant, items, address, fees, and total:
  `ordercli foodora reorder <orderCode> --confirm`
- Address override (confirm the resolved address ID first):
  `ordercli foodora reorder <orderCode> --confirm --address-id <id>`
- Never treat `--confirm` as user consent. Run the preview first and wait for
  explicit approval of that exact order/address before changing the cart.

Cloudflare / bot protection

- Browser login: `ordercli foodora login --email you@example.com --password-stdin --browser`
- Reuse profile: `--browser-profile "$HOME/Library/Application Support/ordercli/browser-profile"`
- Import Chrome cookies: `ordercli foodora cookies chrome --profile "Default"`

Session import (no password)

- `ordercli foodora session chrome --url https://www.foodora.at/ --profile "Default"`
- `ordercli foodora session refresh --client-id android`

Deliveroo (WIP, not working yet)

- Requires `DELIVEROO_BEARER_TOKEN` (optional `DELIVEROO_COOKIE`).
- `ordercli deliveroo config set --market uk`
- `ordercli deliveroo history`

Notes

- Use `--config /tmp/ordercli.json` for testing.
- Confirm the resolved preview before any reorder or cart-changing action.
