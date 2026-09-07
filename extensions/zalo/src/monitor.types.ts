// Zalo type declarations define plugin contracts.
export type ZaloRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};
