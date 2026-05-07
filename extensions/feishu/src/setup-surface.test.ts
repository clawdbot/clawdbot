import {
  createNonExitingRuntimeEnv,
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeishuProbeResult } from "./types.js";

const { probeFeishuMock } = vi.hoisted(() => ({
  probeFeishuMock: vi.fn<() => Promise<FeishuProbeResult>>(async () => ({
    ok: false,
    error: "mocked",
  })),
}));

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./app-registration.js", () => ({
  initAppRegistration: vi.fn(async () => {
    throw new Error("mocked: scan-to-create not available");
  }),
  beginAppRegistration: vi.fn(),
  pollAppRegistration: vi.fn(),
  printQrCode: vi.fn(async () => {}),
  getAppOwnerOpenId: vi.fn(async () => undefined),
}));

import { feishuPlugin } from "./channel.js";

const baseStatusContext = {
  accountOverrides: {},
};

async function withEnvVars(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, prior] of previous.entries()) {
      if (prior === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prior;
      }
    }
  }
}

async function getStatusWithEnvRefs(params: { appIdKey: string; appSecretKey: string }) {
  return await feishuGetStatus({
    cfg: {
      channels: {
        feishu: {
          appId: { source: "env", id: params.appIdKey, provider: "default" },
          appSecret: { source: "env", id: params.appSecretKey, provider: "default" },
        },
      },
    } as never,
    ...baseStatusContext,
  });
}

const feishuConfigure = createPluginSetupWizardConfigure(feishuPlugin);
const feishuGetStatus = createPluginSetupWizardStatus(feishuPlugin);

afterAll(() => {
  vi.doUnmock("./probe.js");
  vi.doUnmock("./app-registration.js");
  vi.resetModules();
});

describe("feishu setup wizard", () => {
  beforeEach(() => {
    probeFeishuMock.mockReset();
    probeFeishuMock.mockResolvedValue({ ok: false, error: "mocked" });
  });

  it("does not throw when config appId/appSecret are SecretRef objects", async () => {
    const text = vi
      .fn()
      .mockResolvedValueOnce("cli_from_prompt")
      .mockResolvedValueOnce("secret_from_prompt");
    const prompter = createTestWizardPrompter({
      text,
      confirm: vi.fn(async () => true),
      select: vi.fn(
        async ({ initialValue }: { initialValue?: string }) => initialValue ?? "bot",
      ) as never,
    });

    await expect(
      runSetupWizardConfigure({
        configure: feishuConfigure,
        cfg: {
          channels: {
            feishu: {
              appId: { source: "env", id: "FEISHU_APP_ID", provider: "default" },
              appSecret: { source: "env", id: "FEISHU_APP_SECRET", provider: "default" },
            },
          },
        } as never,
        prompter,
        runtime: createNonExitingRuntimeEnv(),
      }),
    ).resolves.toBeTruthy();
  });
});

describe("feishu setup wizard status", () => {
  beforeEach(() => {
    probeFeishuMock.mockReset();
    probeFeishuMock.mockResolvedValue({ ok: false, error: "mocked" });
  });

  it("treats SecretRef appSecret as configured when appId is present", async () => {
    const status = await feishuGetStatus({
      cfg: {
        channels: {
          feishu: {
            appId: "cli_a123456",
            appSecret: {
              source: "env",
              provider: "default",
              id: "FEISHU_APP_SECRET",
            },
          },
        },
      } as never,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
  });

  it("probes the resolved default account in multi-account config", async () => {
    probeFeishuMock.mockResolvedValueOnce({ ok: true, botName: "Feishu Main" });

    const status = await feishuGetStatus({
      cfg: {
        channels: {
          feishu: {
            enabled: true,
            defaultAccount: "main-bot",
            accounts: {
              "main-bot": {
                appId: "cli_main",
                appSecret: "main-app-secret", // pragma: allowlist secret
                connectionMode: "websocket",
              },
            },
          },
        },
      } as never,
      ...baseStatusContext,
    });

    expect(status.configured).toBe(true);
    expect(status.statusLines).toEqual(["Feishu: connected as Feishu Main"]);
    expect(probeFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main-bot",
        appId: "cli_main",
        appSecret: "main-app-secret", // pragma: allowlist secret
      }),
    );
  });

  it("does not fallback to top-level appId when account explicitly sets empty appId", async () => {
    const status = await feishuGetStatus({
      cfg: {
        channels: {
          feishu: {
            appId: "top_level_app",
            accounts: {
              main: {
                appId: "",
                appSecret: "sample-app-credential", // pragma: allowlist secret
              },
            },
          },
        },
      } as never,
      ...baseStatusContext,
    });

    expect(status.configured).toBe(false);
  });

  it("treats env SecretRef appId as not configured when env var is missing", async () => {
    const appIdKey = "FEISHU_APP_ID_STATUS_MISSING_TEST";
    const appSecretKey = "FEISHU_APP_CREDENTIAL_STATUS_MISSING_TEST"; // pragma: allowlist secret
    await withEnvVars(
      {
        [appIdKey]: undefined,
        [appSecretKey]: "env-credential-456", // pragma: allowlist secret
      },
      async () => {
        const status = await getStatusWithEnvRefs({ appIdKey, appSecretKey });
        expect(status.configured).toBe(false);
      },
    );
  });

  it("treats env SecretRef appId/appSecret as configured in status", async () => {
    const appIdKey = "FEISHU_APP_ID_STATUS_TEST";
    const appSecretKey = "FEISHU_APP_CREDENTIAL_STATUS_TEST"; // pragma: allowlist secret
    await withEnvVars(
      {
        [appIdKey]: "cli_env_123",
        [appSecretKey]: "env-credential-456", // pragma: allowlist secret
      },
      async () => {
        const status = await getStatusWithEnvRefs({ appIdKey, appSecretKey });
        expect(status.configured).toBe(true);
      },
    );
  });
});
