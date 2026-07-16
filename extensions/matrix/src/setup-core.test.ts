import { describe, expect, it } from "vitest";
import { matrixSetupAdapter } from "./setup-core.js";
import type { CoreConfig } from "./types.js";

function applyOpsAccountConfig(cfg: CoreConfig): CoreConfig {
  return matrixSetupAdapter.applyAccountConfig({
    cfg,
    accountId: "ops",
    input: {
      name: "Ops",
      homeserver: "https://matrix.example.org",
      accessToken: "ops-token",
    },
  }) as CoreConfig;
}

function expectPromotedDefaultAccount(next: CoreConfig): void {
  expect(next.channels?.matrix?.accounts?.Default).toMatchObject({
    enabled: true,
    deviceName: "Legacy raw key",
    homeserver: "https://matrix.example.org",
    userId: "@default:example.org",
    accessToken: "default-token",
    avatarUrl: "mxc://example.org/default-avatar",
  });
  expect(next.channels?.matrix?.accounts?.default).toBeUndefined();
}

function expectOpsAccount(next: CoreConfig): void {
  expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
    name: "Ops",
    enabled: true,
    homeserver: "https://matrix.example.org",
    accessToken: "ops-token",
  });
}

describe("matrixSetupAdapter", () => {
  it("moves legacy default config before writing a named account", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@default:example.org",
          accessToken: "default-token",
          deviceName: "Default device",
        },
      },
    } as CoreConfig;

    const next = matrixSetupAdapter.applyAccountConfig({
      cfg,
      accountId: "ops",
      input: {
        name: "Ops",
        homeserver: "https://matrix.example.org",
        userId: "@ops:example.org",
        accessToken: "ops-token",
      },
    }) as CoreConfig;

    expect(next.channels?.matrix?.homeserver).toBeUndefined();
    expect(next.channels?.matrix?.userId).toBeUndefined();
    expect(next.channels?.matrix?.accessToken).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.default).toMatchObject({
      homeserver: "https://matrix.example.org",
      userId: "@default:example.org",
      accessToken: "default-token",
      deviceName: "Default device",
    });
    expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
      name: "Ops",
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "ops-token",
    });
  });

  it("reuses an existing raw default-account key during promotion", () => {
    const cfg = {
      channels: {
        matrix: {
          defaultAccount: "default",
          homeserver: "https://matrix.example.org",
          userId: "@default:example.org",
          accessToken: "default-token",
          avatarUrl: "mxc://example.org/default-avatar",
          accounts: {
            Default: {
              enabled: true,
              deviceName: "Legacy raw key",
            },
          },
        },
      },
    } as CoreConfig;

    const next = applyOpsAccountConfig(cfg);

    expectPromotedDefaultAccount(next);
    expectOpsAccount(next);
  });

  it("reuses an existing raw default-like key during promotion when defaultAccount is unset", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@default:example.org",
          accessToken: "default-token",
          avatarUrl: "mxc://example.org/default-avatar",
          accounts: {
            Default: {
              enabled: true,
              deviceName: "Legacy raw key",
            },
            support: {
              homeserver: "https://matrix.example.org",
              accessToken: "support-token",
            },
          },
        },
      },
    } as CoreConfig;

    const next = applyOpsAccountConfig(cfg);

    expectPromotedDefaultAccount(next);
    expect(next.channels?.matrix?.accounts?.support).toMatchObject({
      homeserver: "https://matrix.example.org",
      accessToken: "support-token",
    });
    expectOpsAccount(next);
  });

  it("clears stored auth fields when switching an account to env-backed auth", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              name: "Ops",
              homeserver: "https://matrix.example.org",
              proxy: "http://127.0.0.1:7890",
              userId: "@ops:example.org",
              accessToken: "ops-token",
              password: "secret",
              deviceId: "DEVICE",
              deviceName: "Ops device",
            },
          },
        },
      },
    } as CoreConfig;

    const next = matrixSetupAdapter.applyAccountConfig({
      cfg,
      accountId: "ops",
      input: {
        name: "Ops",
        useEnv: true,
      },
    }) as CoreConfig;

    expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
      name: "Ops",
      enabled: true,
    });
    expect(next.channels?.matrix?.accounts?.ops?.homeserver).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.proxy).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.userId).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.accessToken).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.password).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.deviceId).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.deviceName).toBeUndefined();
  });

  it("keeps avatarUrl when switching an account to env-backed auth", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              name: "Ops",
              homeserver: "https://matrix.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    const next = matrixSetupAdapter.applyAccountConfig({
      cfg,
      accountId: "ops",
      input: {
        name: "Ops",
        useEnv: true,
        avatarUrl: "  mxc://example.org/ops-avatar  ",
      },
    }) as CoreConfig;

    expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
      name: "Ops",
      enabled: true,
      avatarUrl: "mxc://example.org/ops-avatar",
    });
    expect(next.channels?.matrix?.accounts?.ops?.homeserver).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.ops?.accessToken).toBeUndefined();
  });

  it("stores proxy in account setup updates", () => {
    const next = matrixSetupAdapter.applyAccountConfig({
      cfg: {} as CoreConfig,
      accountId: "ops",
      input: {
        homeserver: "https://matrix.example.org",
        accessToken: "ops-token",
        proxy: "http://127.0.0.1:7890",
      },
    }) as CoreConfig;

    expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "ops-token",
      proxy: "http://127.0.0.1:7890",
    });
  });

  it("stores avatarUrl from setup input on the target account", () => {
    const next = matrixSetupAdapter.applyAccountConfig({
      cfg: {} as CoreConfig,
      accountId: "ops",
      input: {
        homeserver: "https://matrix.example.org",
        accessToken: "ops-token",
        avatarUrl: "  mxc://example.org/ops-avatar  ",
      },
    }) as CoreConfig;

    expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "ops-token",
      avatarUrl: "mxc://example.org/ops-avatar",
    });
  });

  it("rejects unsupported avatar URL schemes during setup validation", () => {
    const validationError = matrixSetupAdapter.validateInput?.({
      cfg: {} as CoreConfig,
      accountId: "ops",
      input: {
        homeserver: "https://matrix.example.org",
        accessToken: "ops-token",
        avatarUrl: "file:///tmp/avatar.png",
      },
    });

    expect(validationError).toBe("Matrix avatar URL must be an mxc:// URI or an http(s) URL.");
  });

  it("stores canonical dangerous private-network opt-in from setup input", () => {
    const next = matrixSetupAdapter.applyAccountConfig({
      cfg: {} as CoreConfig,
      accountId: "ops",
      input: {
        homeserver: "http://matrix.internal:8008",
        accessToken: "ops-token",
        dangerouslyAllowPrivateNetwork: true,
      },
    }) as CoreConfig;

    expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
      enabled: true,
      homeserver: "http://matrix.internal:8008",
      accessToken: "ops-token",
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
  });

  it("keeps top-level block streaming as a shared default when named accounts already exist", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@default:example.org",
          accessToken: "default-token",
          blockStreaming: true,
          accounts: {
            support: {
              homeserver: "https://matrix.example.org",
              userId: "@support:example.org",
              accessToken: "support-token",
            },
          },
        },
      },
    } as CoreConfig;

    const next = matrixSetupAdapter.applyAccountConfig({
      cfg,
      accountId: "ops",
      input: {
        name: "Ops",
        homeserver: "https://matrix.example.org",
        userId: "@ops:example.org",
        accessToken: "ops-token",
      },
    }) as CoreConfig;

    expect(next.channels?.matrix?.blockStreaming).toBe(true);
    expect(next.channels?.matrix?.accounts?.ops).toMatchObject({
      name: "Ops",
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "ops-token",
    });
    expect(next.channels?.matrix?.accounts?.ops?.blockStreaming).toBeUndefined();
  });
});
