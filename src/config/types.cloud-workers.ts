// Defines cloud-worker provider profile configuration types.

export type CloudWorkerLifetimePolicyConfig = {
  /** Minutes of inactivity before the environment becomes eligible for cleanup. */
  idleTimeoutMinutes?: number;
  /** Maximum environment lifetime in minutes. */
  maxLifetimeMinutes?: number;
};

export type CloudWorkerProfileConfig = {
  /** Worker provider id registered by a plugin. */
  provider: string;
  /** Worker install method (default: bundle); npm requires a released gateway version. */
  install?: "bundle" | "npm";
  /** Provider-owned JSON settings; secret-bearing fields use SecretRef objects. */
  settings?: Record<string, unknown>;
  /** Stored lifecycle policy; enforcement is owned by later worker lifecycle support. */
  lifetime?: CloudWorkerLifetimePolicyConfig;
};

export type CloudWorkersConfig = {
  /** Named opt-in worker profiles. Omit or leave empty to disable cloud workers. */
  profiles?: Record<string, CloudWorkerProfileConfig>;
};
