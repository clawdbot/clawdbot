export type MockFn<T extends (...args: unknown[]) => unknown = (...args: unknown[]) => unknown> =
  import("vitest").Mock<T>;
