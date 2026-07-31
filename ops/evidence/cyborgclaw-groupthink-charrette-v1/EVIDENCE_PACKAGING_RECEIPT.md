# Evidence packaging receipt

Repository package root:
`ops/evidence/cyborgclaw-groupthink-charrette-v1`

The evidence builder:

- refuses symlinks, non-regular files, and multiply linked files;
- verifies the frozen source logical-tree digest before writing inventories;
- writes the complete 49-entry `SOURCE_TREE_INVENTORY.json`;
- writes `INTERNAL_SHA256SUMS.sha256` for every evidence file except itself;
- leaves the final archive digest outside the archive in an exact-basename
  `.sha256` sidecar to avoid checksum recursion.

The final export must additionally prove:

- internal SHA-256 verification is clean;
- ZIP integrity is clean;
- no absolute, parent-traversal, or backslash archive paths exist;
- no symlink archive entries exist;
- no high-confidence secret pattern exists;
- shared repository/exported evidence files are byte-identical;
- the final branch head, draft status, and unmerged state are recorded in a
  detached post-commit custody receipt.

The closeout commit cannot contain its own object ID. The repository evidence
therefore records the source/evidence commit and stable draft-PR identity. The
final branch-head OID belongs in the detached exported receipt and terminal
report; no recursive follow-up commit is created.
