# Reviewer memory

## Fakery / evidence patterns

- **Unreproducible extract digest:** Coder claimed `failure_extract_sha256=c782dd8c…` for `/tmp/openclaw-iter0-full-test.log`, but hashing all ` FAIL ` lines yields `9986964d…`. Treat claimed sub-digests as unverified unless the exact extract bytes are staged.
- **Selective full-suite failure listing:** `observed_failures.failure_files` matched the 109 ` FAIL ` headings (systemd/git-root/backup/exec-render), but the same log also contains many `×` lines for snapshot/doctor/browser paths that never appear as ` FAIL ` headings and conflict with shard summaries (`Tests 2 failed` in unit-src). Require classification of both reporter forms.
- **Preserved RED without primary logs:** RED asserted only via `eval_output.json` summaries + chat narrative; no staged pre-fix stdout/SHA. Do not treat summary-only RED as independently verified.
- **Stale goal path vs corrected sibling path:** `goal.json` sibling cmd still points at missing `…/run/settled-turn-finalization-result.test.ts`; real file is `src/agents/harness/settled-turn-finalization-result.test.ts`. Accept correction only after confirming the corrected suite is the intended sibling.
- **Iter diff ≠ candidate:** `iter-0/diff.patch` may be ledger-only while product candidate lives at an earlier SHA (`c0774e8d…`). Always hash base→candidate product paths, not only the staged iter patch.
