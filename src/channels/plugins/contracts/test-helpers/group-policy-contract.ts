/**
 * Channel runtime group-policy contract fixtures.
 *
 * Exposes stable resolver names for shared open-provider policy contract tests.
 */
import { resolveOpenProviderRuntimeGroupPolicy } from "../../../../config/runtime-group-policy.js";

const resolveWhatsAppRuntimeGroupPolicy = resolveOpenProviderRuntimeGroupPolicy;
const resolveZaloRuntimeGroupPolicy = resolveOpenProviderRuntimeGroupPolicy;

export { resolveWhatsAppRuntimeGroupPolicy, resolveZaloRuntimeGroupPolicy };
