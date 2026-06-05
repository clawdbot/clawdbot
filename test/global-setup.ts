// Global test setup installs shared environment before Vitest projects run.
import { installTestEnv } from "./test-env";

export default async () => {
  const { cleanup } = installTestEnv();
  return () => cleanup();
};
