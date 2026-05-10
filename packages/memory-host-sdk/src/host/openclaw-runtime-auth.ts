import { requireApiKey } from "../../../../src/agents/model-auth-runtime-shared.js";
import type { resolveApiKeyForProvider as ResolveApiKeyForProvider } from "../../../../src/agents/model-auth.js";

export { requireApiKey };

export const resolveApiKeyForProvider: typeof ResolveApiKeyForProvider = async (...args) => {
  const auth = await import("../../../../src/agents/model-auth.js");
  return auth.resolveApiKeyForProvider(...args);
};
