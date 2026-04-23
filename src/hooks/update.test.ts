import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookNpmIntegrityDriftParams } from "./install.js";

const installHooksFromNpmSpecMock = vi.fn();

vi.mock("./install.js", () => ({
  installHooksFromNpmSpec: (...args: unknown[]) => installHooksFromNpmSpecMock(...args),
  resolveHookInstallDir: (hookId: string) => `/tmp/hooks/${hookId}`,
}));

const { updateNpmInstalledHookPacks } = await import("./update.js");

function createHookInstallConfig(params: {
  hookId: string;
  spec: string;
  integrity?: string;
}): OpenClawConfig {
  return {
    hooks: {
      internal: {
        installs: {
          [params.hookId]: {
            source: "npm",
            spec: params.spec,
            installPath: `/tmp/hooks/${params.hookId}`,
            ...(params.integrity ? { integrity: params.integrity } : {}),
          },
        },
      },
    },
  } as OpenClawConfig;
}

describe("updateNpmInstalledHookPacks", () => {
  beforeEach(() => {
    installHooksFromNpmSpecMock.mockReset();
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
});
