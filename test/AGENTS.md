# Test Rules

- Fake-timer tests in `unit-fast` belong in `vitest.unit-fast-fake-timers`: `unit-fast` is `isolate: false` and parallel, so fake timers share worker globals and can hang unrelated real-timer tests.
