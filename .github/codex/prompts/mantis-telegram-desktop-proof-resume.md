Your previous turn ended, but `MANTIS_OUTPUT_DIR/mantis-evidence.json` does not
exist, so this run still has no verdict. Continue the same proof now. A handoff,
summary, or plan is not an acceptable final message; the turn is finished only
when the manifest exists.

Context may have been compacted. Do not trust remembered PR details: re-read
`MANTIS_PR_CONTEXT` and `MANTIS_INSTRUCTIONS`, then inspect your own files under
`MANTIS_OUTPUT_DIR` (scenario scripts, lane output, facts) to see what already
ran. A lane may still be active from the earlier attempt: if `start` reports it
already has an active session, `abort --lane <lane>` first. Every rule from the
original instructions still applies. Finish by building `mantis-evidence.json`
with `scripts/mantis/build-telegram-desktop-proof-evidence.mts`, using `block`
for any lane whose proof is genuinely impossible.
