/**
 * Vitest mock function type alias shared by Browser tests.
 */
/** Generic Vitest mock function type with a callable signature. */
export type MockFn<T extends (...args: unknown[]) => unknown = (...args: unknown[]) => unknown> =
  import("vitest").Mock<T>;
