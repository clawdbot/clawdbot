import { installTestEnv } from "./test-env";

export default async () => {
  const { cleanup } = installTestEnv();
  return () => cleanup();
};
