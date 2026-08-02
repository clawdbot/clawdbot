# CLAUDE.md — quantflow-pro-main

Context and operating rules for Claude Code sessions on this repo. Read this fully before making changes.

---

## What this repo is

QuantFlow Terminal — an options/futures flow-analysis and trading-intelligence platform.
Stack: Next.js 14 (App Router) / TypeScript / Supabase / Stripe.
Primary instruments: ES, NQ, SPY, QQQ, GC, SI.

This is a **research and decision-support / education** product. It is **not** marketed as guaranteed profits, managed money, a fund, or personalized financial advice. Keep all copy, labels, and API responses inside that framing.

---

## Repo history — read before trusting anything

This codebase has a documented history of serious problems. Do not assume prior work is sound; verify against the build and tests.

Known issues found in earlier audits of `quantflow-pro-main`:
- Did not compile.
- Crashed on startup.
- **Presented fabricated data as live** — the cardinal sin of this repo:
  - Synthetic GEX values shown as real.
  - Dark-pool figures generated with `Math.random()`.
  - A fictional Finnhub handler that returned invented data.
  - Wrong Tradier / Polygon endpoints.
  - ML models trained on synthetic data.

If you find any of the above still present, flag it as **CRITICAL** before doing anything else.

---

## Non-negotiable rules

### 1. No fabricated data presented as live. Ever.
- Any value that is mock, demo, simulated, delayed, or synthetic MUST be explicitly labeled as such in the type, the API response, and the UI.
- No `Math.random()` standing in for market data.
- Enforce stale-data detection. If data is stale or the provider is down, say so — do not fill the gap with invented numbers.
- Mock mode must be disabled in production unless clearly marked as demo.

### 2. NBBO AMBIGUOUS hard contract.
- The NbboBook must never guess a stale NBBO. When the book is ambiguous, it returns `AMBIGUOUS` — it does not fabricate a best bid/offer to keep a classifier happy.
- Any classifier consuming NBBO must handle `AMBIGUOUS` explicitly, not coerce it to a default.

### 3. Complete working files only.
- No stubs, no placeholders, no partial samples, no `TODO` left where logic belongs.
- No `any` casts to make the type-checker pass. Fix the type.

### 4. Never claim it works without proof.
- Do not say "production-ready," "fixed," or "working" unless `tsc --noEmit` passes, the build succeeds, and the relevant tests pass. Show the command output.

---

## Signal / flow-engine domain rules (God's Plan alignment)

The flow-classification and signal logic must stay disciplined:
- Flow classifiers: SWEEP / BLOCK / LARGE / SPLIT, with a 0–100 unusualness score and a full audit trail per classification.
- Outcome Tracker grades signals at M15 / H1 / D1 / EXPIRY as POSITIVE / NEGATIVE / NEUTRAL / UNGRADED. Ungraded is a valid state — don't force a grade.
- Signals carry a lifecycle and an audit log; decisions are explainable, not black-box.
- Default posture is conservative: when confirmation is missing, the honest output is "neutral / waiting / blocked," not a manufactured signal.

---

## Coding standards

- Shared types, clean services, modular engines. No unsafe shortcuts.
- Error handling, input validation, structured logging, and extensibility on every module.
- Supabase: full RLS on every table. Don't add a table without its policies.
- Replace any hand-authored `Database` type with the generated one from Supabase.
- Webhook payloads (Stripe, TradingView ingestion) must be verified, not trusted.
- Secrets never committed. If a key appears in the working tree or history, stop and flag it for rotation.

---

## How to report work (every session)

When you make changes, report in this order:
1. **Files changed** — exact paths.
2. **Commands run** — install / typecheck / build / test, with results.
3. **Issues found** — ranked by severity, critical first.
4. **Issues fixed** — what and how.
5. **Remaining blockers** — what still fails.
6. **Next pass** — the concrete next step.

No fake claims. If something is untested, say it's untested.

---

## Session startup checklist

Run these first to establish real state before continuing:

```bash
git status
git log --oneline -10
npm install
npx tsc --noEmit
npm test
```

Trust the output of these over any memory or prior claim about the repo compiling or passing.

---

## Outstanding items (update as they close)

- [ ] Confirm repo compiles: `tsc --noEmit` clean.
- [ ] Confirm test suite passes.
- [ ] Verify no fabricated-data handlers remain (GEX, dark pool, Finnhub, ML).
- [ ] Confirm any exposed API keys (e.g. Firecrawl) have been rotated.
- [ ] Confirm mock/demo data is labeled everywhere it surfaces.
