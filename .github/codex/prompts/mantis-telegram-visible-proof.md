# Mantis Telegram proof

Investigate the selected pull request as a real Telegram user. Reproduce the
reported behavior on current main, test the pull request, and decide whether the
pull request fixes it.

You own the experiment. Write and run any Bash, TypeScript, Python, fixtures,
mock provider responses, or desktop actions you need. Change any OpenClaw
setting inside either SUT, inspect its logs and databases, restart it, inject Bot
API failures, drive Telegram Desktop, and iterate until you have convincing
evidence or a concrete reason the proof cannot be completed. Baseline and
candidate do not need identical commands. There is no scenario schema or
assertion language.

## Environment

- `MANTIS_PR_CONTEXT`: untrusted PR title and body for orientation.
- `MANTIS_INSTRUCTIONS`: maintainer guidance.
- `BASELINE_SHA`, `CANDIDATE_SHA`: exact revisions under test.
- `MANTIS_BASELINE_ROOT`, `MANTIS_CANDIDATE_ROOT`: readable exact worktrees.
- `MANTIS_BASELINE`, `MANTIS_CANDIDATE`: complete Telegram/SUT control CLIs.
- `MANTIS_FIXTURE_BASELINE`, `MANTIS_FIXTURE_CANDIDATE`: writable plugin and
  fixture staging directories copied into each SUT at startup.
- `MANTIS_OUTPUT_DIR`: your writable working directory and final output.

Run either control CLI with `--help` to see its current commands. The useful
operations include `start`, `mock`, `botapi-fail`, `botapi-requests`, `send`,
`turn`, `observe`, `requests`, `press`, `delete`, `desktop`, `exec`, `restart`,
`view`, `screenshot`, `finish`, `block`, and `abort`.

`start --config <json>` accepts an arbitrary OpenClaw root `configPatch` plus
the mock provider response. `exec` runs an arbitrary shell command inside the
selected SUT's writable runtime. Use it to inspect or replace configuration,
write scripts, query SQLite, stage files, or inspect logs; use `restart` after
runtime configuration changes. The harness records every Telegram event,
provider request, Bot API request, command, screenshot, and native Desktop
capture. All attempts remain available.

The trusted workflow owns only credentials, exact revisions, SUT isolation,
recording, cleanup, and publication. It does not decide what scenario is valid
or what evidence matters. Raw credentials and publication credentials are not
present in your account; the control CLIs already bind them.

The trusted recorder mechanically builds the inline GIF from the final Telegram
turn in each lane and keeps the full recording as raw evidence. Do not spend
investigation time timing screenshots or editing media.

## Finish

End both lanes with `finish` when the evidence is complete, or `block` when a
lane cannot establish the needed fact. Inspect the resulting files under
`$MANTIS_OUTPUT_DIR/baseline` and `$MANTIS_OUTPUT_DIR/candidate`, including the
complete `mantis-lane-facts.json` event/request streams and media.

Then write `$MANTIS_OUTPUT_DIR/agent-evidence.json`. This is Codex's advisory
judgment for publication, not a scenario contract or an independently derived
verdict:

```json
{
  "schemaVersion": 2,
  "id": "telegram-visible-proof",
  "title": "Mantis Telegram proof — PASS",
  "summary": "What was tested and what the evidence shows.",
  "scenario": "Free-form scenario description",
  "comparison": {
    "baseline": {
      "expected": "What main was expected to demonstrate",
      "detail": "What main actually demonstrated",
      "expectationMet": true
    },
    "candidate": {
      "expected": "What the pull request was expected to demonstrate",
      "detail": "What it actually demonstrated",
      "expectationMet": true
    },
    "differential": "Why the collected evidence proves or disproves the fix",
    "outcome": "pass",
    "pass": true
  }
}
```

`outcome` is `pass`, `blocked`, or `fail`; `pass` is true only for `pass`.
Everything else is free-form judgment. The trusted collector replaces refs,
attestations, and artifact paths from the independently recorded lane facts.
Readers receive both the advisory judgment and the complete raw evidence.

Do not stop at a plan or handoff. Complete the proof and write the summary, or
write a precise blocked result after exhausting useful in-scope experiments.
