// Covers canonical dev gateway bootstrap config generation.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawSchema } from "../../config/zod-schema.js";

const mocks = vi.hoisted(() => ({
  configPath: "",
  workspace: "",
  nextConfig: undefined as unknown,
  replaceConfigFile: vi.fn(),
}));

vi.mock("../../agents/workspace-templates.js", () => ({
  resolveWorkspaceTemplateSearchDirs: async () => [],
}));

vi.mock("../../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: () => mocks.workspace,
}));

vi.mock("../../commands/onboard-helpers.js", () => ({
  handleReset: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  createConfigIO: () => ({ configPath: mocks.configPath }),
  replaceConfigFile: (options: unknown) => mocks.replaceConfigFile(options),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { log: vi.fn() },
}));

vi.mock("../../utils.js", () => ({
  resolveUserPath: (value: string) => value,
  shortenHomePath: (value: string) => value,
}));

const { ensureDevGatewayConfig } = await import("./dev.js");

describe("ensureDevGatewayConfig", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-dev-config-"));
    mocks.configPath = path.join(tempDir, "openclaw.json");
    mocks.workspace = path.join(tempDir, "workspace");
    mocks.nextConfig = undefined;
    mocks.replaceConfigFile.mockReset();
    mocks.replaceConfigFile.mockImplementation(async (options: unknown) => {
      mocks.nextConfig = (options as { nextConfig: unknown }).nextConfig;
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes a config that uses the canonical keyed agent entries shape", async () => {
    await ensureDevGatewayConfig({});
    const devWorkspace = `${mocks.workspace}-dev`;

    expect(mocks.nextConfig).toEqual({
      gateway: { mode: "local", bind: "loopback" },
      agents: {
        defaults: { workspace: devWorkspace, skipBootstrap: true },
        entries: {
          dev: {
            default: true,
            workspace: devWorkspace,
            identity: { name: "C3-PO", theme: "protocol droid", emoji: "🤖" },
          },
        },
      },
    });
    expect(OpenClawSchema.safeParse(mocks.nextConfig).success).toBe(true);
  });
});
