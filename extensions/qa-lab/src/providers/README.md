# QA Provider Lanes

QA provider lanes are registered in `index.ts` and implemented in one folder per
provider. Shared provider contracts and mock-provider helpers live in `shared/`.
Mock lanes should use `shared/mock-provider-definition.ts` unless they need a
custom shape.

Each provider definition owns:

- its accepted `providerMode`
- default primary, alternate, and image-generation model refs
- gateway `models.providers` config, when the lane needs config injection
- model runtime params such as SSE transport, fast mode, or thinking defaults
- optional local server startup for mock lanes
- optional placeholder auth profile providers for mock lanes
- whether the lane uses real provider plugins and live environment aliases

Shared suite code should import only `providers/index.ts` and ask the selected
provider for behavior. Do not add provider-name branches to suite, gateway,
manual-lane, or live-transport runtime code unless the registry contract is
missing a needed capability.
