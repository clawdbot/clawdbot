---
scope: project
---

## User prefers async communication

The user has mentioned twice (sessions 2026-04-15 and 2026-04-22) that
they prefer Slack DMs over meetings for short questions.

## Project uses TypeScript with strict mode

The codebase enforces `strict: true` and `noUncheckedIndexedAccess`.
Avoid `any`; prefer `unknown` with narrowing.

## Deploy on Tuesdays only

Production deploys happen Tue 9am-12pm Pacific. Outside that window,
deploys go to staging and wait for the next Tuesday window.
