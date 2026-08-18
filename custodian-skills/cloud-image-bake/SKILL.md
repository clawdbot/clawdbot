---
name: cloud-image-bake
description: Bake, select, dispatch-prove, and safely retire a Cloud Worker image.
---

# Bake a Cloud Worker image

Never print or persist secret values; use SecretRefs and provider credential stores. Never hand-edit config files on disk. Every run ends with the observable Prove result or an exact explanation of why it could not be proven. Snapshots are cheap; unmanaged snapshot sprawl is not.

Follow [Cloud Workers](https://docs.openclaw.ai/gateway/cloud-workers) and the active provider's image documentation.

## Gather

Read `cloudWorkers.profiles.<profile>` with `gateway` `config.get`, then use `crabbox config show --json`, `crabbox doctor --provider <backend> --json`, and the read-only lease/image inventory. Record the current provider, class, image selection, setup, and superseded image id. Confirm the requested tooling and a secret-free bake source.

## Mutate

Lease from the current profile with `crabbox warmup --provider <backend> --class <class> --keep --timing-json`, then install and smoke-test the requested tooling with `crabbox run --id <lease> -- ...`.

- AWS: create a native image checkpoint with `crabbox checkpoint create --provider aws --id <lease> --mode native --strategy image --wait`, inspect it, then run `crabbox image promote <ami-id>` with the matching scope.
- Hetzner: create the project snapshot with `hcloud image create --type snapshot --server <server-id> --description <name>`. There is no Crabbox Hetzner create/promote lifecycle for shared defaults; record this lifecycle gap and the explicit image selection outside OpenClaw.
- Firecracker: rebuild and publish the rootfs template through the provider's documented template pipeline; do not snapshot a running microVM as a substitute.

Ask Custodian to run `config_schema` for the exact profile setting, then use approved `config_set` only for a supported image selector. The current Crabbox OpenClaw profile has no `image` key: AWS selection is owned by `crabbox image promote`; never invent a config field. Preserve the old image until proof passes.

## Repair

Run `openclaw doctor`. If repair is required, obtain approval and run `openclaw doctor --fix` outside the active Custodian inference session, then re-read the profile and provider inventory.

## Prove

Create a disposable managed-worktree session and time one real `sessions.dispatch` to the profile, using a generous Gateway timeout. Confirm the placement reaches `active`, the requested tooling runs on the worker, and record dispatch duration. If any step fails, roll back the image selection and report the exact blocker.

## Report

Report the profile, backend, new and previous image ids, tooling smoke, dispatch duration, and rollback state. Only after successful proof, show the exact provider deletion target and get hard human confirmation. Then delete only that superseded snapshot (`crabbox image delete` or `hcloud image delete`) and verify it is absent; without confirmation, leave it intact and report cleanup pending.
