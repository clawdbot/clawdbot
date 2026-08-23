import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import {
  FREETOKEN_DEFAULT_API_KEY_ENV_VAR,
  FREETOKEN_DEFAULT_BASE_URL,
  FREETOKEN_MODEL_PLACEHOLDER,
} from "./api.js";
import plugin from "./index.js";

describe("FreeToken provider plugin", () => {
  it("registers the provider with stable local defaults", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("freetoken");
    expect(FREETOKEN_DEFAULT_BASE_URL).toBe("http://127.0.0.1:1919/v1");
    expect(FREETOKEN_DEFAULT_API_KEY_ENV_VAR).toBe("FREETOKEN_API_KEY");
    expect(FREETOKEN_MODEL_PLACEHOLDER).toBe("Qwen/Qwen3.6-35B-A3B");
  });
});
