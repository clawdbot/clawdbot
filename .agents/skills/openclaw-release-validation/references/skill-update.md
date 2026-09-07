# Installed skill check

When `RELEASE_VALIDATION_ARTIFACT_PATH` is present, this is the non-interactive
**Campaign artifact** workflow. Skip this section entirely: do not make a
network request or prompt for a skill update.

For **Validate release** and **Update campaign**, before the introduction, resolve this loaded skill's directory from the available skill
catalog and run:

```sh
node <skill-directory>/scripts/check-update.mjs
```

Read its JSON and show one concise status line with the installed ClawHub
source and version, the current canonical ClawHub version, and the comparison
status. Do not show local paths. This check is read-only.

When `status` is `update-available` and `localModifications` is `false`, ask:

```text
A newer canonical release-validation skill is available. Would you like me to
upgrade it before validation?

Reply exactly `upgrade release-validation skill` or `continue with current skill`.
```

When `status` is `update-available` and `localModifications` is `true`, say that
the installed copy has local modifications and ask:

```text
A newer canonical release-validation skill is available, but this installed
copy has local modifications. Upgrading will replace those modifications.

Reply exactly `upgrade release-validation skill and replace local modifications`
or `continue with current skill`.
```

Wait for the applicable reply. On either approved upgrade reply, run the
checker's exact `update.command` arguments from `update.cwd`; do not construct a
different install command. Rerun the checker and require `status: current`.
Then stop this run and tell the tester to start a fresh task and invoke the
skill again, because the current task has already loaded the old instructions.
Never continue release validation in that task after changing the skill.

On `continue with current skill`, continue normally. For `current`, continue
without asking. For `ahead-of-latest`, `local-modifications`,
`different-source`, `untracked`, or `check-failed`, report the installed source
and version plus the status briefly and continue without offering an automated
update; the checker could not prove that replacing this copy is safe.
