---
name: cloud-image-bake
description: Bake, select, prove, and safely retire a Cloud Worker image with crabbox and config one-liners.
---

# Bake a Cloud Worker image

Never print or persist secret values; provider credentials stay in their stores. Never hand-edit config files on disk — profile changes go through `openclaw config`. Every run ends with the observable Prove result or an exact explanation of why it could not be proven. Snapshots are cheap; unmanaged snapshot sprawl is not. Never delete a provider image without hard operator confirmation.

## Gather

```
openclaw config get cloudWorkers --json
crabbox config show --json
crabbox doctor --provider <backend> --json
crabbox checkpoint list --json
```

Record the current provider, class, image selection, setup command, and the id of the image being superseded. Confirm the requested tooling and a secret-free bake source.

## Mutate

Lease from the current profile, install and smoke-test the tooling:

```
crabbox warmup --provider <backend> --class <class> --keep --timing-json
crabbox run --provider <backend> --id <lease> --no-sync -- bash -lc '<install commands> && <tool> --version'
```

Snapshot per backend:

- AWS: `crabbox checkpoint create --provider aws --id <lease> --mode native --strategy image --wait`, inspect it, then `crabbox image promote <ami-id>` with the matching scope. AWS image selection is owned by the promote catalog.
- Hetzner: `hcloud image create --type snapshot --server <server-id> --description <name>`; there is no crabbox create/promote lifecycle for Hetzner yet, so record the snapshot id explicitly.
- Firecracker: rebuild and republish the rootfs template through the host's template pipeline; do not snapshot a running microVM as a substitute.

Point the profile at the new selection only through validated config writes — confirm the exact key first, dry-run, then write (example for a backend whose settings carry an image field):

```
openclaw config schema --json | jq '.properties.cloudWorkers'
openclaw config set cloudWorkers.profiles.<profile>.settings.<imageKey> "<image-id>" --dry-run
openclaw config set cloudWorkers.profiles.<profile>.settings.<imageKey> "<image-id>"
```

The bundled crabbox profile currently has no `image` settings key — AWS selection lives in `crabbox image promote`; never invent a config field. Preserve the old image until proof passes.

## Repair

```
openclaw doctor --lint
crabbox doctor --provider <backend> --json
```

`doctor --lint` can exit `1` for findings: read the report and continue the remaining checks. Ordinary `doctor` and `doctor --non-interactive` can write config/state; do not use them for diagnosis before approval. Apply `openclaw doctor --fix --non-interactive` only after explicit approval, then re-read the profile and provider inventory.

## Prove

Lease once from the new image and verify the baked tooling is present and fast:

```
crabbox warmup --provider <backend> --class <class> --timing-json
crabbox run --provider <backend> --id <lease> --no-sync -- bash -lc '<tool> --version'
crabbox stop --provider <backend> --id <lease>
```

Record warmup total and compare against the pre-bake timing. Then confirm the OpenClaw path end to end: dispatch one session to the profile from a client (Cloud destination) and verify the placement reaches active. If any step fails, roll back the image selection and report the exact blocker.

## Report

Report the profile, backend, new and previous image ids, tooling smoke result, timed warmup before/after, and rollback state. Only after successful proof, show the exact deletion target and get hard operator confirmation, then delete only that superseded snapshot (`crabbox image delete <id>` or `hcloud image delete <id>`) and verify it is gone. Without confirmation, leave it intact and report cleanup pending.

Further reference: https://docs.openclaw.ai/gateway/cloud-workers
