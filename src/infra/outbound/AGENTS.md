# Outbound Test Performance

Outbound helpers sit on hot reply, action, media, and channel contract paths.
Keep argument and payload tests narrow unless they are intentionally exercising
real delivery.

## Guardrails

- Prefer pure param/spec/normalization helpers for send-argument, media-source,
  alias, and payload-shape coverage. Do not import real delivery runtimes when
  the test only asserts normalized arguments.
- Avoid partial-real mocks with `importActual()` around broad outbound delivery
  modules. Mock the exact seam under test, then cover the real delivery runtime
  in a focused integration test.
- Before discovering plugin-owned media/action metadata, first check whether the
  call actually includes plugin-owned params. Standard send params should not
  trigger bundled channel message-tool discovery.

## Verification

- Benchmark the affected outbound test file before/after with
  `pnpm test <file>`.
- Run the closest media/action/payload contract test when changing a shared
  outbound helper.
