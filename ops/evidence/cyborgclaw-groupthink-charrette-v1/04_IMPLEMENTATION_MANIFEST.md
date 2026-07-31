# Implementation manifest

Canonical source: `.agents/skills/cyborgclaw-groupthink-charrette`

Version: `1.0.0`

Status: `production`

Runtime: Node 22 or newer; zero third-party runtime dependencies.

Frozen pre-review source inventory:

- logical-tree digest:
  `3c788a417c3b00586760845d60f5859599c85acc9673bc8775b0ea97a80c05aa`
- entries: 49
- payload files in `SHA256SUMS.sha256`: 39
- checksum-manifest SHA-256:
  `67a199980d30931dfd049a84c8f6c3f863550919347b05b20b2200c15e9c3813`
- `SKILL.md` SHA-256:
  `118925c8e8f465eb02b5d41698adbb5da6759b8f22217160fac2aa393f057da9`
- `manifest.json` SHA-256:
  `b3da7ed17fba41e171bfa4533031a5057253ebd8543db374e55a93ef2ee82c41`
- examples: 5, covering every terminal decision
- tests: 161

The skill contains:

- `SKILL.md` and Codex interface metadata;
- Glen Proxy Charter and lifecycle protocol;
- immutable constants and provenance;
- session, findings, and S.ADR Schemas;
- strict JSON, decision, rendering, checksum, integrity, validation, and
  installation tools;
- decision template, executable fixtures, and five outcome examples;
- routing, contract, decision, adversarial, CLI, rendering, and installer tests.

The logical-tree inventory includes files, directories, modes, and content
digests. The payload checksum manifest deliberately excludes itself to avoid
checksum recursion. All countable final reviews must name the logical-tree
digest above. Any later source-tree change invalidates those reviews and
requires a complete review restart.
