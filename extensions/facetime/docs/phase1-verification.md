# FaceTime verification contract

## Automated proof

```bash
node scripts/run-vitest.mjs extensions/facetime
sh -n extensions/facetime/scripts/*.sh
(cd extensions/facetime && npm pack --dry-run)
```

The automated boundary proves state/generation fencing, exact pending-dial
persistence, helper authentication and bounds, typed native outcomes,
closure-bound consult cancellation, provider response ownership, native
protocol compatibility, driver rollback, and uninstall inventory. Package
inspection must show no native source, generated driver, dylib, `.build`, or
BlackHole artifact.

The native `.dataPlayedBack` callback proves consumption by the configured
`OpenClaw-Feed` output device. It does not prove remote audibility.

## Live proof gap

A consensual inbound and outbound round trip is still required separately for
FaceTime video and Phone-owned FaceTime Audio. Live proof must confirm remote
input/output, barge-in, agent consultation, direct hangup, physical-speaker
suppression, and child-process teardown. Automated validation must not place
calls, change SIP, enable developer tools, install the driver, restart the
operator Gateway, or modify operator configuration.
