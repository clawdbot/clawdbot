// Lazy runtime bridge for exact-profile provider usage reads.
import { readProviderUsageProfile } from "../../infra/provider-usage.profile.js";
import type {
  ProviderUsageProfileReadParams,
  ProviderUsageProfileSnapshot,
} from "../../infra/provider-usage.types.js";

export async function readProviderUsageProfileForRuntime(
  params: ProviderUsageProfileReadParams,
): Promise<ProviderUsageProfileSnapshot> {
  return await readProviderUsageProfile(params);
}
