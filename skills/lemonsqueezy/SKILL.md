---
name: lemonsqueezy
description: LemonSqueezy CLI for revenue, orders, subscriptions, and customer data.
homepage: https://lemonsqueezy.com
metadata: {"clawdbot":{"emoji":"🍋","requires":{"bins":["bun"],"env":["LEMONSQUEEZY_API_KEY"]},"primaryEnv":"LEMONSQUEEZY_API_KEY"}}
---

# LemonSqueezy CLI

Query revenue, orders, subscriptions, and customers from LemonSqueezy.

## Setup

Set the API key:
```bash
export LEMONSQUEEZY_API_KEY="your_api_key"
```

Or configure in `~/.clawdbot/clawdbot.json`:
```json
{
  "skills": {
    "entries": {
      "lemonsqueezy": {
        "apiKey": "your_api_key"
      }
    }
  }
}
```

## Commands

### Revenue Overview
```bash
bun {baseDir}/scripts/cli.ts overview
```

### Orders
```bash
bun {baseDir}/scripts/cli.ts orders                    # Recent orders
bun {baseDir}/scripts/cli.ts orders --limit 10         # Limit results
bun {baseDir}/scripts/cli.ts orders --status paid      # Filter: paid/refunded/pending
bun {baseDir}/scripts/cli.ts orders --from 2025-11-01 --to 2026-01-20  # Date range with week-by-week summary
```

### Order Lookup
```bash
bun {baseDir}/scripts/cli.ts order 12345               # By order number
bun {baseDir}/scripts/cli.ts order customer@email.com  # By customer email
```

### Subscriptions
```bash
bun {baseDir}/scripts/cli.ts subs                      # All with status breakdown
bun {baseDir}/scripts/cli.ts subs --status active      # Filter by status
```

Status values: active, cancelled, expired, on_trial, paused, past_due, unpaid

### MRR Breakdown
```bash
bun {baseDir}/scripts/cli.ts mrr                       # MRR by product/variant
```

### Customers
```bash
bun {baseDir}/scripts/cli.ts customers                 # Customer list with LTV
bun {baseDir}/scripts/cli.ts customers --limit 50
```

### Products
```bash
bun {baseDir}/scripts/cli.ts products                  # All products with URLs
```

### Refunds
```bash
bun {baseDir}/scripts/cli.ts refunds                   # Refunded orders
bun {baseDir}/scripts/cli.ts refunds --limit 10
```

## Output Icons

- ✓ = paid
- ↩ = refunded
- ○ = pending
- ● = active subscription
- ◐ = other status

## Examples

```bash
# Daily revenue check
bun {baseDir}/scripts/cli.ts overview

# Recent sales
bun {baseDir}/scripts/cli.ts orders --limit 5

# Find customer orders
bun {baseDir}/scripts/cli.ts order support@example.com

# Subscription health
bun {baseDir}/scripts/cli.ts subs --status active

# Track refunds
bun {baseDir}/scripts/cli.ts refunds
```

## Notes

- Revenue displayed in USD
- API rate limit: 300 calls/minute
- See `{baseDir}/docs/API_REFERENCE.md` for full API documentation
