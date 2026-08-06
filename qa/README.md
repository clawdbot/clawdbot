# QA Scenarios

Seed QA assets for the private `qa-lab` extension.

Files:

- `scenarios/index.yaml` - canonical QA scenario pack, kickoff mission, and operator identity.
- `scenarios/<theme>/*.yaml` - one runnable scenario per YAML file.
- `frontier-harness-plan.md` - big-model bakeoff and tuning loop for harness work.
- `convex-credential-broker/` - standalone Convex v1 lease broker for pooled live credentials.

Key workflow:

- `qa suite` is the executable frontier subset / regression loop.
- `qa manual` is the scoped personality and style probe after the executable subset is green.
- `qa coverage` prints the scenario coverage inventory from scenario YAML.

Operator workflows:

- Use the `openclaw-qa-testing` skill for QA Lab live lanes, Convex credential
  pool operations, and WhatsApp live credential setup/replacement.

Keep this folder in git. Add new scenarios here before wiring them into automation.
