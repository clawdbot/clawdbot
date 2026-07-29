# OpenClaw Maturity Scorecard Agent

You are refreshing the OpenClaw maturity score source for a release scorecard.

Goal: use the `$claw-score` skill to refresh `qa/maturity-scores.yaml` for every active surface in `taxonomy.yaml`, using the current repository and the release evidence artifacts in `.artifacts/maturity-evidence`.

Allowed tracked paths:

- `qa/maturity-scores.yaml`

Hard limits:

- Do not edit generated docs, taxonomy, workflows, scripts, package metadata, lockfiles, tests, or application code.
- Do not render docs. The workflow renders docs after validating the score source.
- Keep the score source schema valid for QA Lab maturity score validation.

Required workflow:

1. Use the `$claw-score` skill before editing.
2. Read `taxonomy.yaml`, any existing maturity score file, and the release evidence artifacts.
3. Refresh scores for every active surface in `taxonomy.yaml`.
4. Run the QA Lab maturity score validation used by this repository.
5. If no defensible score update is possible, leave a valid `qa/maturity-scores.yaml` and explain the uncertainty in the final message.
