# PR #81190 runtime proof

This proof runs the current `recoverEmbeddedRunOverflow()` implementation in a
Docker-isolated build environment. It uses a temporary SQLite transcript and
synthetic tool output only. It does not mount the operator's OpenClaw home,
gateway state, Telegram credentials, or user data.

Run:

```bash
OPENCLAW_RUNTIME_PROOF_LOG=/tmp/openclaw-pr-81190-runtime-proof.log \
  scripts/proof/docker-runtime-proof.sh
```

Reuse the image for an unchanged checkout:

```bash
OPENCLAW_SKIP_DOCKER_BUILD=1 \
OPENCLAW_RUNTIME_PROOF_LOG=/tmp/openclaw-pr-81190-runtime-proof.log \
  scripts/proof/docker-runtime-proof.sh
```

The proof expects tool-heavy generic overflow recovery to apply append-only
tool-result truncation before compaction. It verifies that compaction is not
called, the original SQLite transcript row remains unchanged, and the active
branch contains a shortened replacement.
