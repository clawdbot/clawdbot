# Standalone Claw CLI Incubator

This private workspace package proves the future harness-neutral Claw command
without selecting or publishing its final npm identity.

```bash
OPENCLAW_EXPERIMENTAL_CLAWS=1 pnpm claws:standalone -- ./path/to/claw --agent openclaw --dry-run
```

The portable layer validates local package input and dispatches to a harness.
The OpenClaw adapter delegates planning to `openclaw claws add --dry-run`; it
does not reproduce OpenClaw consent, mutation, provenance, or removal policy.

The package is intentionally `private`, uses a temporary `claws-dev` binary,
and is excluded from OpenClaw npm release selection.
