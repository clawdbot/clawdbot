# OpenClaw #85651 third-cycle provenance correction

## §4 — independent exact-upstream control

- Control source was exact frozen upstream
  `0d4e369b1c3df59cd77b59bba87aac17884742b1` in a temporary worktree with
  identical manifests and dependency graph.
- A direct isolated Knip 6.8.0 all-exports scan on that control exited zero,
  emitted no finding, and produced `type_hit_count=0` for
  `ReadSessionMessagesAsyncOptions`.
- The directly scanned candidate pre-fix checkpoint
  `02998ee8a3a0d8c5ffb758566cef0c1746cefbe7` reported the
  `ReadSessionMessagesAsyncOptions` re-export as unused.
- Internal type uses remain in `session-utils.fs.ts`; candidate composition
  orphaned only the public re-export in `session-transcript-readers.ts`.
- Commit `63e2dd0536a` removes exactly that one orphaned export. This is a
  candidate-caused, behavior-neutral cure, not unrelated upstream cleanup.
