import { describe, expect, it } from "vitest";
import { resolveMemoryBackendConfig as packageResolveMemoryBackendConfig } from "../../../packages/memory-host-sdk/src/host/backend-config.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";

describe("memory-host-sdk backend-config bridge", () => {
  it("exports the package-owned backend resolver", () => {
    expect(resolveMemoryBackendConfig).toBe(packageResolveMemoryBackendConfig);
  });
});
