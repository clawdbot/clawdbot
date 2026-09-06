# Worksheet and human testing

Only when readiness is verified, copy
[the worksheet asset](../assets/validation-worksheet.md) to
`.artifacts/openclaw-release-validation/<stable-train>-<timestamp>.md`. Fill its
run identity, test mode, source, issue URL, terminal upgrade result, eligible
upgrade findings, and relevant tester-authored PRs when useful for choosing
checks. Insert the campaign body's exact marked guidance bytes
at `{{VALIDATION_GUIDANCE}}`. In those bytes, replace `{{OPENCLAW}}` with
`ocm @<test-env> --` for either OCM lane or `openclaw` for the plain in-place
lane. Replace `{{RESTART_GATEWAY}}` with `ocm service restart <test-env>` for
either OCM lane or `openclaw gateway restart` for the plain in-place lane. Use
the actual environment name. No placeholder may remain.

Do not regenerate or reformat the two priority sections. They are the current
campaign dashboard. The local worksheet may change only in its run fields,
upgrade findings, authored PRs, testing notes, additional tested surfaces, and
final feedback. Never write local substitutions or notes back to the issue body.

Resolve the worksheet's absolute path and open it yourself with the appropriate
platform command: `open '<absolute-path>'` on macOS, `xdg-open
'<absolute-path>'` on Linux, or `start "" "<absolute-path>"` on Windows. If
opening fails, report the error and continue. After opening it, print only:

```text
Testing worksheet: /absolute/path/to/worksheet.md
```

Then give this compact orientation, using the actual worksheet contents:

- **What it is:** their private run record and the source for the final
  release-feedback comment; it is not another task to complete.
- **Priority and scorecard:** the first three surfaces cover the release train
  overall; the second three cover changes landed on main since the current beta
  was cut. Their
  maturity values come from the live scorecard, where higher maturity carries a
  stronger regression expectation. Any scorecard surface may still be tested.
- **How to use each surface:** **What changed** summarizes the release theme,
  and **Recommended testing** gives a concrete manual exercise and pass
  condition.
- **How to leave feedback:** as they test, they should simply tell the agent
  their notes and name the surface (for example, `Models: switching persisted
after restart`). The agent adds those notes to that surface's **Testing
  notes** cell. They do not need to edit the file themselves.

Finish with the exit instruction: **You can stop after any amount of testing;
you do not need to cover every surface. When you are ready to wrap up, reply
exactly `finish validation`.** That tells the agent to collect any missing
promotion feedback, safely end the selected test mode, and prepare a reviewable
consolidated release-feedback draft. Then ask which surface they want to test
first.

This worksheet is the only checklist and note store. Readiness is verified at
this point, so continue to human-driven testing.

## Human testing

Ask: **What do you want to test first?** Recommend starting with a release
priority, but let the tester choose one surface at a time in any order. After
each item, add their notes to that surface's **Testing notes** table cell, then
ask what they want to test next.

The tester drives interactive surfaces such as the TUI, Control UI, onboarding,
channels, pairing, and approvals. Provide the command or URL and explain what
to look for, then wait for their result. Take control only when explicitly
asked. Do not turn the checklist into an automated scenario runner.

A surface counts as tested only when tester-authored text appears in its
**Testing notes** row. The other rows are guidance, never evidence. An empty
cell means untouched. Escape table pipes and use `<br>` between notes. When a
surface appears in both priority sections, mirror its notes into both tables but
deduplicate it in the final report.

If the tester chooses a non-priority surface, resolve it from the live
scorecard, guide one concrete manual check, and add a matching table under
**Additional surfaces tested**. Do not add the full scorecard catalog.

### Investigate each problem immediately

When the tester reports a release problem, first record it under the named
surface, then immediately search open and closed `openclaw/openclaw` issues with
bounded, specific queries. Inspect plausible matches and the linked fix or PR;
do not classify from search snippets alone.

Choose exactly one disposition and create one private Markdown draft beside the
worksheet:

- **Comment on existing issue:** a related issue is open. Draft a concise
  corroborating comment with the tested beta, tested main SHA, reproduction,
  expected/observed behavior, and sanitized evidence.
- **Create issue:** no open match exists and no confirmed fix applies. Draft a
  complete issue with the same identity and evidence plus the exact
  `release-validation-finding` label.
- **Found but fixed:** a concrete fix is confirmed in the tested main SHA or a
  newer published beta. Draft a short local record naming the fix URL. Do not
  post it separately; the final campaign report says the problem was found but
  already fixed.

A closed duplicate, stale issue, unsupported report, or unclear change is not a
confirmed fix. Keep searching or use **Create issue**. Telemetry may corroborate
tester-reported behavior but may not invent a finding. Sanitize every draft:
never include local paths, gateway/environment names, credentials, user
identifiers, raw logs, prompts, responses, tool payloads, or cleanup/setup
details. Tell the tester the draft is queued for review; do not post it yet.
