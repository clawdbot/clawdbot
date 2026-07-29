import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const writeWizardConfigFile = vi.hoisted(() => vi.fn());

vi.mock("../../wizard/setup.shared.js", () => ({ writeWizardConfigFile }));

import { commitNonInteractiveOnboardConfig } from "./config-write.js";

describe("commitNonInteractiveOnboardConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeWizardConfigFile.mockImplementation(async (config: OpenClawConfig) => config);
  });

  it("keeps the verified config hash and pending-install owner on the canonical writer", async () => {
    const baseConfig: OpenClawConfig = {
      plugins: {
        installs: { demo: { source: "npm", spec: "demo@1.0.0" } },
      },
    };
    const nextConfig: OpenClawConfig = {
      ...baseConfig,
      gateway: { port: 19_001 },
    };

    await expect(
      commitNonInteractiveOnboardConfig({
        nextConfig,
        baseConfig,
        baseHash: "verified-config-hash",
      }),
    ).resolves.toBe(nextConfig);

    expect(writeWizardConfigFile).toHaveBeenCalledWith(nextConfig, {
      allowConfigSizeDrop: false,
      baseHash: "verified-config-hash",
      migrationBaseConfig: baseConfig,
    });
  });

  it("permits config size reduction only for an explicitly requested reset", async () => {
    const baseConfig: OpenClawConfig = { gateway: { port: 19_001 } };
    const nextConfig: OpenClawConfig = {};

    await commitNonInteractiveOnboardConfig({
      nextConfig,
      baseConfig,
      reset: true,
    });

    expect(writeWizardConfigFile).toHaveBeenCalledWith(nextConfig, {
      allowConfigSizeDrop: true,
      migrationBaseConfig: baseConfig,
    });
  });
});
