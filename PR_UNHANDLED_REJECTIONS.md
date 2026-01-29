# Proposal: Configurable gateway unhandled promise rejection policy

## Motivation
Running Clawdbot Gateway in production-like environments can encounter transient network errors (undici `fetch failed`, DNS hiccups, Telegram API blips). Today, any *unhandled* promise rejection can terminate the gateway process (`process.exit(1)`), causing user-visible downtime and missed replies.

Diego’s deployment uses systemd with `Restart=always`, but the restart still interrupts message handling.

## Desired behavior
Add a JSON config knob to control what happens on unhandled promise rejections:

```json5
{
  gateway: {
    unhandledRejections: "warn" // or "exit"
  }
}
```

- `exit` (default): keep current behavior for safety; exit 1 so supervisors restart.
- `warn`: never exit the gateway for unhandled rejections; log as error/warn and continue.

## Notes
- Existing suppression for AbortError / transient network errors should remain regardless of mode.
- In `warn` mode, non-network/unexpected unhandled rejections should still be logged loudly.

## Acceptance criteria
- With `gateway.unhandledRejections="warn"`, a forced Telegram DNS failure should result in a logged error but the gateway process should remain running.
- With `exit` (default), behavior remains unchanged.
