import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const configMocks = vi.hoisted(() => ({
  replaceConfigFile: vi.fn(),
  resolveConfigSnapshotHash: vi.fn(),
}));
const secretsMocks = vi.hoisted(() => ({
  activeSnapshot: null as {
    sourceConfig: OpenClawConfig;
    config: OpenClawConfig;
  } | null,
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    replaceConfigFile: configMocks.replaceConfigFile,
    resolveConfigSnapshotHash: configMocks.resolveConfigSnapshotHash,
  };
});

vi.mock("../../secrets/runtime-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../secrets/runtime-state.js")>();
  return {
    ...actual,
    getActiveSecretsRuntimeSnapshotState: () => secretsMocks.activeSnapshot,
  };
});

import { commitGatewayConfigWrite, didActiveSharedGatewayAuthChange } from "./config-write-flow.js";

describe("commitGatewayConfigWrite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.resolveConfigSnapshotHash.mockReturnValue("missing-config-revision");
    configMocks.replaceConfigFile.mockResolvedValue({
      nextConfig: {},
      persistedHash: "persisted-hash",
    });
    secretsMocks.activeSnapshot = null;
  });

  it("carries a missing file revision into the lock-time compare-and-swap", async () => {
    const snapshot = {
      path: "/tmp/openclaw.json",
      exists: false,
      raw: null,
      hash: "missing-config-revision",
    };

    await commitGatewayConfigWrite({
      snapshot: snapshot as never,
      writeOptions: {},
      nextConfig: {} satisfies OpenClawConfig,
    });

    expect(configMocks.replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        baseHash: "missing-config-revision",
        nextConfig: {},
      }),
    );
  });

  it("returns the managed runtime application claimed during the write", async () => {
    configMocks.replaceConfigFile.mockImplementationOnce(async (params) => {
      const application = getRuntimeConfigWriteApplication(params.writeOptions);
      const claim = application?.claim();
      claim?.settle("applied");
      return {
        nextConfig: { hooks: { enabled: true } },
        persistedHash: "persisted-hash",
      };
    });

    const result = await commitGatewayConfigWrite({
      snapshot: {
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        hash: "base-hash",
      } as never,
      writeOptions: {},
      nextConfig: { hooks: { enabled: true } },
      awaitRuntimeApplication: true,
    });

    await expect(result.application).resolves.toBe("applied");
  });

  it("returns an unclaimed required application when no managed reloader is installed", async () => {
    const result = await commitGatewayConfigWrite({
      snapshot: {
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        hash: "base-hash",
      } as never,
      writeOptions: {},
      nextConfig: { hooks: { enabled: true } },
      awaitRuntimeApplication: true,
    });

    await expect(result.application).resolves.toBe("unclaimed");
  });
});

describe("didActiveSharedGatewayAuthChange", () => {
  beforeEach(() => {
    secretsMocks.activeSnapshot = null;
  });

  it("preserves runtime-only auth fields absent from the active secrets source", () => {
    const runtimeConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "runtime-token" } },
    };
    secretsMocks.activeSnapshot = {
      sourceConfig: {},
      config: {},
    };

    expect(
      didActiveSharedGatewayAuthChange({ fallbackPrev: runtimeConfig, next: runtimeConfig }),
    ).toBe(false);
  });

  it("does not trust active secret values from a stale authored source", () => {
    secretsMocks.activeSnapshot = {
      sourceConfig: { gateway: { auth: { mode: "token", token: "token-a" } } },
      config: { gateway: { auth: { mode: "token", token: "token-a" } } },
    };
    const current: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "token-b" } },
    };

    expect(
      didActiveSharedGatewayAuthChange({
        fallbackPrev: current,
        fallbackSource: current,
        next: { gateway: { auth: { mode: "token", token: "token-a" } } },
      }),
    ).toBe(true);
  });

  it("preserves runtime-only siblings beside authored shared auth fields", () => {
    secretsMocks.activeSnapshot = {
      sourceConfig: { gateway: { auth: { mode: "token" } } },
      config: { gateway: { auth: { mode: "token" } } },
    };
    const runtimeConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "runtime-token" } },
    };

    expect(
      didActiveSharedGatewayAuthChange({
        fallbackPrev: runtimeConfig,
        fallbackSource: { gateway: { auth: { mode: "token" } } },
        next: runtimeConfig,
      }),
    ).toBe(false);
  });

  it("uses active secret-expanded values when the authored source still matches", () => {
    const tokenRef = {
      source: "env" as const,
      provider: "default",
      id: "GATEWAY_TOKEN",
    };
    secretsMocks.activeSnapshot = {
      sourceConfig: { gateway: { auth: { mode: "token", token: tokenRef } } },
      config: { gateway: { auth: { mode: "token", token: "old-token" } } },
    };

    expect(
      didActiveSharedGatewayAuthChange({
        fallbackPrev: { gateway: { auth: { mode: "token", token: tokenRef } } },
        fallbackSource: { gateway: { auth: { mode: "token", token: tokenRef } } },
        next: { gateway: { auth: { mode: "token", token: "new-token" } } },
      }),
    ).toBe(true);
  });
});
