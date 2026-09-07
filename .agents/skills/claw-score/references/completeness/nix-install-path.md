# Nix install path Completeness

Use this rubric when assigning category Completeness scores for the
`nix-install-path` surface.

## Category Scope

- Install Handoff: Nix install overview, nix-openclaw source-of-truth, Install discoverability, Verification handoff
- Plugin Lifecycle: Lifecycle command refusal, Declarative plugin selection, Nix-store plugin loading, Hardlink safety
- Activation and App UX: Environment activation, macOS defaults activation, Runtime Nix-mode detection, Stable Nix defaults, Managed-by-Nix banner, Read-only config controls, Onboarding skip
- Config and State: Immutable config guard, Config writer refusal, Agent-first Nix edits, Explicit config path, Writable state directory, Immutable-store config support, State integrity checks
- Service Runtime and Guards: Nix profile PATH discovery, Profile precedence, Service PATH fallback, Trusted binary boundaries, Setup write refusal, Doctor repair refusal, Update handoff, Service lifecycle handoff
