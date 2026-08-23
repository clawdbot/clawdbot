import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./config-contracts.js";
import { resolveReadOnlyEnvSecretRef } from "./secret-ref-readonly.js";

describe("resolveReadOnlyEnvSecretRef", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns blocked when read-only provider policy forbids resolution", () => {
    vi.stubEnv("EXPECTED_API_KEY", "ambient-value");
    const normalizeValue = vi.fn((value: unknown) =>
      typeof value === "string" && value.trim() ? value.trim() : undefined,
    );
    const cfg = {
      secrets: {
        providers: {
          restricted: {
            source: "env",
            allowlist: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveReadOnlyEnvSecretRef({
        value: {
          source: "env",
          provider: "restricted",
          id: "EXPECTED_API_KEY",
        },
        path: "plugins.entries.example.config.apiKey",
        cfg,
        expectedEnvId: "EXPECTED_API_KEY",
        normalizeValue,
      }),
    ).toEqual({ status: "blocked" });
    expect(normalizeValue).not.toHaveBeenCalled();
  });
});
