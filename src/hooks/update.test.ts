// Hook update tests cover updating installed hook records and config.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookInstallRecord } from "../config/types.hooks.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import type { HookNpmIntegrityDriftParams } from "./install.js";

const installHooksFromNpmSpecMock = vi.fn();
let hookInstalls: Record<string, HookInstallRecord> = {};

vi.mock("./install.js", () => ({
  installHooksFromNpmSpec: (...args: unknown[]) => installHooksFromNpmSpecMock(...args),
  resolveHookInstallDir: (hookId: string) => `/tmp/hooks/${hookId}`,
}));

vi.mock("./installs.js", () => ({
  readHookInstalls: () => hookInstalls,
  recordHookInstall: (cfg: OpenClawConfig, update: HookInstallRecord & { hookId: string }) => {
    const { hookId, ...record } = update;
    hookInstalls = {
      ...hookInstalls,
      [hookId]: {
        ...hookInstalls[hookId],
        ...record,
        installedAt: record.installedAt ?? "2026-05-11T20:00:00.000Z",
      },
    };
    return cfg;
  },
}));

const { updateNpmInstalledHookPacks } = await import("./update.js");

function createHookInstallConfig(params: {
  hookId: string;
  spec: string;
  integrity?: string;
  installPath?: string;
}): OpenClawConfig {
  hookInstalls = {
    [params.hookId]: {
      source: "npm",
      spec: params.spec,
      installPath: params.installPath ?? `/tmp/hooks/${params.hookId}`,
      ...(params.integrity ? { integrity: params.integrity } : {}),
    },
  };
  return {};
}

const tempDirs = createTrackedTempDirs();

async function createInstalledHookPackDir(version: string): Promise<string> {
  const dir = await tempDirs.make("openclaw-hook-pack-");
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "@openclaw/demo-hooks", version }),
  );
  return dir;
}

describe("updateNpmInstalledHookPacks", () => {
  beforeEach(() => {
    installHooksFromNpmSpecMock.mockReset();
    hookInstalls = {};
  });

  afterEach(async () => {
    await tempDirs.cleanup();
  });

  it("aborts exact pinned hook pack updates on integrity drift by default", async () => {
    const warn = vi.fn();
    installHooksFromNpmSpecMock.mockImplementation(
      async (params: {
        spec: string;
        onIntegrityDrift?: (drift: HookNpmIntegrityDriftParams) => boolean | Promise<boolean>;
      }) => {
        const proceed = await params.onIntegrityDrift?.({
          spec: params.spec,
          expectedIntegrity: "sha512-old",
          actualIntegrity: "sha512-new",
          resolution: {
            integrity: "sha512-new",
            resolvedSpec: "@openclaw/demo-hooks@1.0.0",
            version: "1.0.0",
          },
        });
        if (proceed === false) {
          return {
            ok: false,
            error: "aborted: npm package integrity drift detected for @openclaw/demo-hooks@1.0.0",
          };
        }
        return {
          ok: true,
          hookPackId: "demo-hooks",
          hooks: ["demo"],
          targetDir: "/tmp/hooks/demo-hooks",
          version: "1.0.0",
        };
      },
    );

    const config = createHookInstallConfig({
      hookId: "demo-hooks",
      spec: "@openclaw/demo-hooks@1.0.0",
      integrity: "sha512-old",
    });
    const result = await updateNpmInstalledHookPacks({
      config,
      hookIds: ["demo-hooks"],
      logger: { warn },
    });

    expect(warn).toHaveBeenCalledWith(
      'Integrity drift for hook pack "demo-hooks" (@openclaw/demo-hooks@1.0.0): expected sha512-old, got sha512-new',
    );
    expect(result.changed).toBe(false);
    expect(result.config).toBe(config);
    expect(result.outcomes).toEqual([
      {
        hookId: "demo-hooks",
        status: "error",
        message:
          'Failed to update hook pack "demo-hooks": aborted: npm package integrity drift detected for @openclaw/demo-hooks@1.0.0',
      },
    ]);
  });

  it("preserves hook pack update selector and records npm resolution metadata after update", async () => {
    installHooksFromNpmSpecMock.mockResolvedValue({
      ok: true,
      hookPackId: "demo-hooks",
      hooks: ["demo"],
      targetDir: "/tmp/hooks/demo-hooks",
      version: "1.2.3",
      npmResolution: {
        name: "@openclaw/demo-hooks",
        version: "1.2.3",
        resolvedSpec: "@openclaw/demo-hooks@1.2.3",
        integrity: "sha512-new",
        shasum: "abc123",
        resolvedAt: "2026-05-11T20:00:00.000Z",
      },
    });

    const config = createHookInstallConfig({
      hookId: "demo-hooks",
      spec: "@openclaw/demo-hooks",
    });
    const result = await updateNpmInstalledHookPacks({
      config,
      hookIds: ["demo-hooks"],
    });

    expect(installHooksFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        expectedHookPackId: "demo-hooks",
        mode: "update",
      }),
    );
    expect(result.changed).toBe(true);
    expect(hookInstalls["demo-hooks"]).toEqual({
      source: "npm",
      spec: "@openclaw/demo-hooks",
      installPath: "/tmp/hooks/demo-hooks",
      version: "1.2.3",
      resolvedName: "@openclaw/demo-hooks",
      resolvedVersion: "1.2.3",
      resolvedSpec: "@openclaw/demo-hooks@1.2.3",
      integrity: "sha512-new",
      shasum: "abc123",
      resolvedAt: "2026-05-11T20:00:00.000Z",
      hooks: ["demo"],
      installedAt: "2026-05-11T20:00:00.000Z",
    });
  });

  it.each([
    { dryRun: false, message: 'Downgraded hook pack "demo-hooks": 1.2.3 -> 1.2.2.' },
    { dryRun: true, message: 'Would downgrade hook pack "demo-hooks": 1.2.3 -> 1.2.2.' },
  ])(
    "reports hook pack installs that move backwards as downgrades (dryRun: $dryRun)",
    async ({ dryRun, message }) => {
      const installPath = await createInstalledHookPackDir("1.2.3");
      installHooksFromNpmSpecMock.mockResolvedValue({
        ok: true,
        hookPackId: "demo-hooks",
        hooks: ["demo"],
        targetDir: installPath,
        version: "1.2.2",
      });

      const config = createHookInstallConfig({
        hookId: "demo-hooks",
        spec: "@openclaw/demo-hooks",
        installPath,
      });
      const result = await updateNpmInstalledHookPacks({ config, hookIds: ["demo-hooks"], dryRun });

      expect(result.outcomes).toEqual([
        {
          hookId: "demo-hooks",
          status: "updated",
          currentVersion: "1.2.3",
          nextVersion: "1.2.2",
          message,
        },
      ]);
    },
  );
});
