import { resolveOpenProviderRuntimeGroupPolicy } from "../../../../config/runtime-group-policy.js";

// Channel-specific exports for contract tests that need stable resolver names
// while still exercising the shared open-provider policy implementation.
const resolveWhatsAppRuntimeGroupPolicy = resolveOpenProviderRuntimeGroupPolicy;
const resolveZaloRuntimeGroupPolicy = resolveOpenProviderRuntimeGroupPolicy;

export { resolveWhatsAppRuntimeGroupPolicy, resolveZaloRuntimeGroupPolicy };
