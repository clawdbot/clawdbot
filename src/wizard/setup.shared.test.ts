import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withoutPluginInstallRecords } from "../plugins/installed-plugin-index-records.js";

const mocks = vi.hoisted(() => ({
  commitConfigWriteWithPendingPluginInstalls: vi.fn(),
}));

vi.mock("../cli/plugins-install-record-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/plugins-install-record-commit.js")>()),
  commitConfigWriteWithPendingPluginInstalls:
    mocks.commitConfigWriteWithPendingPluginInstalls,
}));

import { writeWizardConfigFile } from "./setup.shared.js";

describe("writeWizardConfigFile pending install ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.commitConfigWriteWithPendingPluginInstalls.mockImplementation(
      async (params: { nextConfig: OpenClawConfig }) => ({
        config: withoutPluginInstallRecords(params.nextConfig),
        installRecords: {},
        movedInstallRecords: true,
        persistedHash: "test-hash",
      }),
    );
  });

  it("rejects a normal write with pending records but no migration base", async () => {
    const config: OpenClawConfig = {
      plugins: { installs: { demo: { source: "npm", spec: "demo@1.0.0" } } },
    };

    await expect(
      writeWizardConfigFile(config, { allowConfigSizeDrop: false }),
    ).rejects.toThrow("declare migration ownership");
    expect(mocks.commitConfigWriteWithPendingPluginInstalls).not.toHaveBeenCalled();
  });

  it("migrates the baseline as source before the final wizard write", async () => {
    const baseConfig: OpenClawConfig = {
      plugins: { installs: { demo: { source: "npm", spec: "demo@1.0.0" } } },
    };

    await writeWizardConfigFile(baseConfig, {
      allowConfigSizeDrop: false,
      migrationBaseConfig: baseConfig,
    });

    expect(mocks.commitConfigWriteWithPendingPluginInstalls).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        nextConfig: baseConfig,
        sourceConfig: baseConfig,
        writeOptions: { allowConfigSizeDrop: true },
      }),
    );
    expect(mocks.commitConfigWriteWithPendingPluginInstalls).toHaveBeenCalledTimes(2);
  });

  it("commits fresh pending records after baseline migration is complete", async () => {
    const config: OpenClawConfig = {
      plugins: { installs: { fresh: { source: "npm", spec: "fresh@1.0.0" } } },
    };

    await writeWizardConfigFile(config, {
      allowConfigSizeDrop: false,
      migrationBaseConfig: undefined,
    });

    expect(mocks.commitConfigWriteWithPendingPluginInstalls).toHaveBeenCalledOnce();
    expect(mocks.commitConfigWriteWithPendingPluginInstalls).toHaveBeenCalledWith(
      expect.objectContaining({ nextConfig: config }),
    );
  });
});
