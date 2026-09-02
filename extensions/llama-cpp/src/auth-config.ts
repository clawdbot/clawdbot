import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { LLAMA_CPP_PROVIDER_ID } from "./defaults.js";

export const LLAMA_CPP_DEFAULT_PROFILE_ID = `${LLAMA_CPP_PROVIDER_ID}:default`;

export function buildLlamaCppAuthProfileRemovalPatch(
  config: OpenClawConfig,
): Partial<OpenClawConfig> {
  const profileExists = Boolean(config.auth?.profiles?.[LLAMA_CPP_DEFAULT_PROFILE_ID]);
  const referencedOrders = Object.entries(config.auth?.order ?? {}).filter(([, ids]) =>
    ids.includes(LLAMA_CPP_DEFAULT_PROFILE_ID),
  );
  if (!profileExists && referencedOrders.length === 0) {
    return {};
  }
  const authPatch: NonNullable<OpenClawConfig["auth"]> = {};
  // Config patches use undefined map values as deletion markers.
  if (profileExists) {
    Reflect.set(authPatch, "profiles", { [LLAMA_CPP_DEFAULT_PROFILE_ID]: undefined });
  }
  if (referencedOrders.length > 0) {
    Reflect.set(
      authPatch,
      "order",
      Object.fromEntries(
        referencedOrders.map(([providerId, ids]) => {
          const next = ids.filter((id) => id !== LLAMA_CPP_DEFAULT_PROFILE_ID);
          return [providerId, next.length > 0 ? next : undefined];
        }),
      ),
    );
  }
  return { auth: authPatch };
}
