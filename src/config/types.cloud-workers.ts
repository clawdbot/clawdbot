// Defines cloud-worker provider profile configuration types.

export type CloudWorkerProfileConfig = {
  /** Worker provider id registered by a plugin. */
  provider: string;
  /** Worker install method (default: bundle); npm requires a released gateway version. */
  install?: "bundle" | "npm";
  /** Reclaim an idle worker after this duration; omitted profiles stay running. */
  suspendAfter?: string;
  /** Provider-owned JSON settings; secret-bearing fields use SecretRef objects. */
  settings?: Record<string, unknown>;
};

export type CloudWorkersConfig = {
  /** Experimental Labs gate for the cloud-worker desktop observer. */
  desktop?: boolean;
  /** Default worker profile names keyed by normalized repository identity. */
  projectProfiles?: Record<string, string>;
  /** Named opt-in worker profiles. Omit or leave empty to disable cloud workers. */
  profiles?: Record<string, CloudWorkerProfileConfig>;
};
