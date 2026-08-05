// Defines cloud-worker provider profile configuration types.

export type CloudWorkerProfileConfig = {
  /** Worker provider id registered by a plugin. */
  provider: string;
  /** Worker install method (default: bundle); npm requires a released gateway version. */
  install?: "bundle" | "npm";
  /** Provider-owned JSON settings; secret-bearing fields use SecretRef objects. */
  settings?: Record<string, unknown>;
};

export type CloudWorkersConfig = {
  /** Named opt-in worker profiles. Omit or leave empty to disable cloud workers. */
  profiles?: Record<string, CloudWorkerProfileConfig>;
};
