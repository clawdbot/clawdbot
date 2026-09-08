# Tooling-feedback packet

Apply this procedure on the first OCM, copying, backup, local-checkout, build,
diagnostics-setup, or cleanup failure. Copy
[the tooling feedback asset](../assets/tooling-feedback.md) to
`.artifacts/openclaw-release-validation/<stable-train>-<timestamp>-tooling-feedback.md`.
Use the run's existing artifact timestamp when one exists. Update the same file
for later tooling failures; a run without a tooling failure has no packet.

Before every write, reduce the evidence to the minimum reproducible facts. Keep
only the release train, tested main SHA when known, operating system and
architecture, relevant tool names and versions, failure stage, sanitized
command shape with placeholders, expected behavior, concise observed behavior
or error category, impact, recovery state, and likely report target. Omit any
field whose safe redaction is uncertain.

Exclude credentials, tokens, usernames, hostnames, device identifiers, network
addresses, absolute paths, gateway or environment names, raw config, raw logs,
prompts, responses, tool payloads, and candidate feedback. Replace sensitive
command arguments with descriptive placeholders.

At closeout, refresh every failure's recovery state and set **Candidate result**
to the assigned terminal label. When no candidate evaluation occurred, set it
to the applicable `Candidate not evaluated — ...` status instead. Replace every
remaining template placeholder, open the packet, and say:

```text
Optional tooling feedback: <absolute path>. Nothing was posted. You can review
this redacted packet and optionally report it to the named tooling project.
```

The packet is private optional-report material. Keep it out of the worksheet,
candidate finding drafts, campaign report, hidden payload, Discord summary, and
validation posting batch. Never post it without a separate user request.

If tooling prevents candidate preparation and the tester ends validation, say
`Candidate not evaluated — tooling blocked preparation`, show the packet, and
stop. This is not a candidate terminal result. Produce no candidate report,
posting batch, hidden payload, or Discord summary.
