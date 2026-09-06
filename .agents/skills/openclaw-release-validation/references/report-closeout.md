# Cleanup and report approval

When the tester says `finish validation`:

1. If readiness is verified, read the worksheet and ask only for a missing
   promotion vote or final feedback. If readiness is blocked, do not create or
   read a worksheet: use the recorded campaign, source, test-target, terminal
   upgrade result, and eligible upgrade findings, then ask only for missing
   promotion feedback.
2. Collect a small **Test environment** profile for the visible report draft.
   This is diagnostic context, not a finding and never enters the hidden
   structured payload. Include only the OS name and version, CPU architecture,
   logical CPU count, memory rounded to the nearest whole GiB, and OCM version
   when an OCM lane was used.
   Read those individual values with narrow native commands; omit an unavailable
   value rather than collecting a broader system profile. Never read or report
   the hostname, username, device model, serial number, UUID, network addresses,
   disk layout, installed software, environment, or a raw command output.
3. If local diagnostics are active, stop the isolated gateway first so its OTLP
   exporters flush, wait briefly for the collector's one-second batch flush,
   then stop the run-owned collector. Read only its three private telemetry
   files. Select at most three short snippets that directly corroborate a
   worksheet note, final feedback, or an eligible upgrade finding. Telemetry
   can strengthen an existing finding but cannot create a new one.
4. Treat telemetry as unsafe source material. Never copy raw JSON, log bodies,
   attributes, resource values, timestamps, trace/span IDs, hostnames, file
   paths, session identifiers, request identifiers, prompts, responses, tool
   inputs, tool outputs, or credentials. A permitted snippet contains only an
   aggregate signal count, a known OpenClaw operation name, a span status, or a
   low-cardinality error category. If relevance or redaction is uncertain, omit
   the telemetry. Label included prose **Local telemetry evidence** and keep it
   immediately below the finding it corroborates. Do not put telemetry in the
   hidden structured payload.
5. For an isolated lane, restore any source gateway stopped for channel
   ownership and ask before destroying the disposable environment. If it is
   retained, retain the run-owned runtime too and disable `diagnostics-otel`,
   set `diagnostics.otel.enabled` to `false`, restart the fixture through OCM,
   and remove the plugin with `ocm @<test-env> -- plugins uninstall
diagnostics-otel --force`. If the fixture is destroyed, remove only its
   run-owned runtime with `ocm runtime remove <run-runtime-name>` after the
   fixture is gone. For an in-place lane, do not stop, downgrade, restore, or
   otherwise rewrite the real gateway automatically. Ask whether the tester
   wants to keep the dev/main installation. If not, explain that newer config
   or database migrations can make a code-only downgrade unsafe, show a
   rollback plan using the OCM upgrade transaction or the verified plain-gateway
   backup as applicable, and require separate explicit approval before any
   rollback or offline state restoration. Remove the run-owned isolated main
   checkout after no build command is using it. Never remove a shared or
   in-use runtime. Remove the run-owned collector in all cases.
6. When a tooling packet exists or cleanup fails, read and apply
   [the tooling-feedback packet procedure](tooling-feedback.md),
   including its closeout rules. If no tooling failure occurred, do not create
   a packet.
7. A completed candidate evaluation requires a candidate-owned readiness
   failure or at least one tester-authored surface result. Without either, say
   `Candidate not evaluated — no tester-authored result`, assign no candidate
   terminal result, and stop after cleanup without creating a candidate report,
   posting batch, hidden payload, or Discord summary. Otherwise assign exactly
   one terminal result using this precedence, and write its
   exact label to the worksheet when one exists, the tooling packet when one
   exists, the visible campaign-report draft when one is warranted, and the
   final Discord summary when one is warranted:

   - **Candidate failed** — the candidate had any functional or readiness
     failure.
   - **Candidate passed, but cleanup failed** — candidate readiness and tested
     behavior passed, but fixture destruction, source restoration, runtime or
     collector removal, plugin cleanup, or approved rollback did not complete.
     Record the failure details only in the tooling packet.
   - **Candidate passed with presentation warnings** — candidate behavior and
     cleanup passed, but the tester reported at least one non-blocking visual,
     wording, output-format, or other presentation/polish warning. Keep those
     warnings in candidate feedback.
   - **Fully clean completion** — candidate behavior passed, cleanup completed,
     and the tester reported no candidate warning or problem finding.

   Candidate failure takes precedence over cleanup failure; cleanup failure
   takes precedence over presentation warnings. Do not use a fifth terminal
   label or collapse these labels into pass/fail.

8. Complete or refresh every finding draft using the final sanitized evidence.
   For an eligible upgrade finding, run the same related-issue investigation
   now if it was not already done before manual testing.
9. Synthesize one final campaign-report draft from the stable train, current
   beta tag and commit, exact tested main SHA, source version/commit, eligible
   upgrade findings, tester feedback, promotion vote, and only surfaces with
   non-empty Testing notes. Link each planned finding draft by its local action
   label; its GitHub URL is inserted after publishing. List **Found but fixed**
   items with their verified fix URL. For a blocked run, list no tested surfaces
   and use the upgrade finding as the evidence. Begin with:

   ```md
   - Release train: <stable train>
   - Current beta: <beta tag> (<beta commit>)
   - Tested main commit: <full SHA>
   - Terminal result: <exact terminal result label>

   ## Test environment

   - OS: <name and version>
   - CPU: <architecture>, <logical core count> logical cores
   - Memory: <whole GiB> GiB
   - OCM: <version, only when used>
   ```

   Omit any unavailable value; do not add substitute device facts. The profile
   is brief diagnostic context, not an upgrade finding or surface result.

10. Remove local paths, gateway names, secrets, user identifiers, raw logs, OCM
    notes, setup details, and cleanup details from the comment. Keep the
    allow-listed **Test environment** values from the preceding step.
11. Read and apply the [structured report contract](structured-report.md).
    Write the proposed root report beside the finding drafts. Open the root
    report plus every **Create issue** and **Comment on existing issue** draft
    together and say:

    ```text
    I opened every proposed GitHub post for review. Nothing has been sent.
    Reply exactly `approve validation posts` to publish this batch, or tell me what to change.
    ```

    On edits, revise and reopen the same files. Never write to GitHub from
    `finish validation` alone.

12. On `approve validation posts`, re-read and privacy-check every approved
    file. Publish each **Create issue** draft with
    `release-validation-finding`, and each corroboration draft to its selected
    open issue. Read every write back. A **Found but fixed** record produces no
    separate post. Insert the resulting issue/comment URLs into the root report,
    append and validate its hidden v2 payload, then automatically create or
    update this GitHub user's one campaign report comment. This mechanical URL
    insertion needs no second approval; do not otherwise rewrite approved prose.
    Return the root comment URL and every finding URL.
13. Give the tester this concise copy-ready Discord summary, populated only from
    the same release-facing worksheet evidence and final comment:

    ```md
    **Release validation — <stable-train> / <current-beta>**
    Tested main: <full SHA>
    Result: <exact terminal result label>
    Tested: <surfaces with non-empty Testing notes, or "No manual surface testing completed">
    Key findings: <concise release findings, or "None reported">
    Recommendation: <yes / no>
    Details: <GitHub comment URL>
    ```

    Keep it to these seven lines. Exclude source gateway details, local paths,
    OCM/setup information, cleanup details, credentials, and untested surface
    guidance. The generic terminal result may name cleanup failure, but no
    tooling detail may appear.
    This is a copy/paste handoff for the tester; do not post it automatically.

The skill collects release feedback; it does not make the go/no-go decision.
