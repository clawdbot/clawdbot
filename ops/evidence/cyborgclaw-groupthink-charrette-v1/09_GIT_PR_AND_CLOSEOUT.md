# Git, draft PR, and closeout custody

## Dedicated branch

- Governing repository: `openclaw/openclaw`
- Publication fork: `THESPRYGUY/openclaw-CyborgClaw`
- Branch: `agent/groupthink-charrette-global-skill-v1`
- Initial isolated-worktree HEAD:
  `cb91659ac6318d4d06b161e24d37b406466e8caa`
- First mission commit:
  `51de777d0df27116f139d863fdc3d1a5bb3284a8`

The first push exposed pre-existing fork history that diverged from the
canonical governing base. A read-only merge-tree check showed that the
`DIRTY` pull-request state came from that inherited history, not from a
mission-owned conflict.

The branch contained exactly one known mission commit. It was replayed onto
verified canonical-`main` ancestor
`13d474134f38b36637473b736d37a3e0e4886140`, producing the governing source
commit:

`5433cf8505eefa6734a50a8bed46607801aacab2`

The remote repair used an exact expected old OID,
`51de777d0df27116f139d863fdc3d1a5bb3284a8`, with force-with-lease. It could
not overwrite unknown remote work. The source logical-tree digest remained
exactly
`3c788a417c3b00586760845d60f5859599c85acc9673bc8775b0ea97a80c05aa`;
the generated validator remained byte-identical to the reviewed and globally
installed payload.

## Draft pull request

- Pull request: https://github.com/openclaw/openclaw/pull/116673
- Number: 116673
- Base: `main`
- Head owner: `THESPRYGUY`
- Head branch: `agent/groupthink-charrette-global-skill-v1`
- State: `OPEN`
- Draft: true
- Merged: false
- Required external-PR `Real behavior proof` check: pass
- Governing source head:
  `5433cf8505eefa6734a50a8bed46607801aacab2`
- Diff at governing-source publication: 76 mission files, 31,809 additions, 0
  deletions

At the later live PR audit, GitHub reported `MERGEABLE` and `BEHIND`. The live
base was `c892a712e675e3df8e490c4f5ac124ef50631691`, 14,087 commits ahead of the
verified ancestor. The replay removed inherited fork divergence and produced a
clean mission-only diff, but it did not claim freshness against the live base.
That substantial lag remains an explicit maintainer-integration limitation and
does not grant or require merge authority.

## Closeout self-reference boundary

The governing source commit contains the frozen skill plus all evidence through
global discovery. This closeout evidence is added by one evidence-only follow-up
commit. A Git commit cannot contain its own object ID, so the final branch-head
OID, final pull-request head check, and exported evidence identity are recorded
in the detached `POST_COMMIT_CUSTODY.json` included in the governed export. The
archive cannot contain its own digest; that digest is recorded only in the
external exact-basename sidecar and terminal report.

No merge, release, production deployment, runtime restart, production
credential/access use, or external product/runtime action occurred. Authorized
GitHub authentication was used only for the exact branch push and draft-PR
publication required by the mission.
