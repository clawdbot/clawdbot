/** Health of the gateway model-pricing sources exposed through health summaries. */
export type GatewayModelPricingHealth = {
  state: "ok" | "degraded" | "disabled";
  sources: Array<{
    source: "openrouter" | "litellm" | "bootstrap" | "refresh";
    state: "ok" | "degraded";
    lastFailureAt?: number;
    detail?: string;
  }>;
  lastFailureAt?: number;
  detail?: string;
};
