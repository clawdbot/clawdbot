import {
  expectLifecyclePatch,
  expectPendingUntilAbort,
  startAccountAndTrackLifecycle,
} from "openclaw/plugin-sdk/channel-test-helpers";
import {
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  listGoogleChatAccountIds,
  resolveGoogleChatAccount,
  resolveDefaultGoogleChatAccountId,
  type ResolvedGoogleChatAccount,
} from "./accounts.js";
import { startGoogleChatGatewayAccount } from "./gateway.js";
import { googlechatSetupAdapter } from "./setup-core.js";
import { googlechatSetupWizard } from "./setup-surface.js";

const hoisted = vi.hoisted(() => ({
  startGoogleChatMonitor: vi.fn(),
}));

vi.mock("./channel.runtime.js", () => ({
  googleChatChannelRuntime: {
    resolveGoogleChatWebhookPath: ({
      account,
    }: {
      account: { config: { webhookPath?: string } };
    }) => account.config.webhookPath ?? "/googlechat",
    startGoogleChatMonitor: hoisted.startGoogleChatMonitor,
  },
}));

const googlechatSetupPlugin = {
  id: "googlechat",
  meta: {
    label: "Google Chat",
  },
  config: {
    defaultAccountId: resolveDefaultGoogleChatAccountId,
    listAccountIds: listGoogleChatAccountIds,
  },
  setupWizard: googlechatSetupWizard,
} as never;

const googlechatConfigure = createPluginSetupWizardConfigure(googlechatSetupPlugin);
const googlechatStatus = createPluginSetupWizardStatus(googlechatSetupPlugin);

function buildAccount(): ResolvedGoogleChatAccount {
  return {
    accountId: "default",
    enabled: true,
    credentialSource: "inline",
    credentials: {},
    config: {
      webhookPath: "/googlechat",
      webhookUrl: "https://example.com/googlechat",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
    },
  };
}

async function waitForGoogleChatMonitorStarted() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (hoisted.startGoogleChatMonitor.mock.calls.length === 1) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(hoisted.startGoogleChatMonitor).toHaveBeenCalledOnce();
}

describe("googlechat setup", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    vi.doUnmock("./channel.runtime.js");
    vi.resetModules();
  });

  it("rejects env auth for non-default accounts", () => {
    if (!googlechatSetupAdapter.validateInput) {
      throw new Error("Expected googlechatSetupAdapter.validateInput to be defined");
    }
    expect(
      googlechatSetupAdapter.validateInput({
        accountId: "secondary",
        input: { useEnv: true },
      } as never),
    ).toBe("GOOGLE_CHAT_SERVICE_ACCOUNT env vars can only be used for the default account.");
  });

  it("requires inline or file credentials when env auth is not used", () => {
    if (!googlechatSetupAdapter.validateInput) {
      throw new Error("Expected googlechatSetupAdapter.validateInput to be defined");
    }
    expect(
      googlechatSetupAdapter.validateInput({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { useEnv: false, token: "", tokenFile: "" },
      } as never),
    ).toBe("Google Chat requires --token (service account JSON) or --token-file.");
  });

  it("builds a patch from token-file and trims optional webhook fields", () => {
    if (!googlechatSetupAdapter.applyAccountConfig) {
      throw new Error("Expected googlechatSetupAdapter.applyAccountConfig to be defined");
    }
    expect(
      googlechatSetupAdapter.applyAccountConfig({
        cfg: { channels: { googlechat: {} } },
        accountId: DEFAULT_ACCOUNT_ID,
        input: {
          name: "Default",
          tokenFile: "/tmp/googlechat.json",
          audienceType: " app-url ",
          audience: " https://example.com/googlechat ",
          webhookPath: " /googlechat ",
          webhookUrl: " https://example.com/googlechat/hook ",
        },
      } as never),
    ).toEqual({
      channels: {
        googlechat: {
          enabled: true,
          name: "Default",
          serviceAccountFile: "/tmp/googlechat.json",
          audienceType: "app-url",
          audience: "https://example.com/googlechat",
          webhookPath: "/googlechat",
          webhookUrl: "https://example.com/googlechat/hook",
        },
      },
    });
  });

  it("prefers inline token patch when token-file is absent", () => {
    if (!googlechatSetupAdapter.applyAccountConfig) {
      throw new Error("Expected googlechatSetupAdapter.applyAccountConfig to be defined");
    }
    expect(
      googlechatSetupAdapter.applyAccountConfig({
        cfg: { channels: { googlechat: {} } },
        accountId: DEFAULT_ACCOUNT_ID,
        input: {
          name: "Default",
          token: { client_email: "bot@example.com" },
        },
      } as never),
    ).toEqual({
      channels: {
        googlechat: {
          enabled: true,
          name: "Default",
          serviceAccount: { client_email: "bot@example.com" },
        },
      },
    });
  });

  it("configures service-account auth and webhook audience", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Service account JSON path") {
          return "/tmp/googlechat-service-account.json";
        }
        if (message === "App URL") {
          return "https://example.com/googlechat";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await runSetupWizardConfigure({
      configure: googlechatConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: {},
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.googlechat?.enabled).toBe(true);
    expect(result.cfg.channels?.googlechat?.serviceAccountFile).toBe(
      "/tmp/googlechat-service-account.json",
    );
    expect(result.cfg.channels?.googlechat?.audienceType).toBe("app-url");
    expect(result.cfg.channels?.googlechat?.audience).toBe("https://example.com/googlechat");
  });

  it("reads the named-account DM policy instead of the channel root", () => {
    expect(
      googlechatSetupWizard.dmPolicy?.getCurrent(
        {
          channels: {
            googlechat: {
              dm: {
                policy: "disabled",
              },
              accounts: {
                alerts: {
                  serviceAccount: { client_email: "bot@example.com" },
                  dm: {
                    policy: "allowlist",
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        "alerts",
      ),
    ).toBe("allowlist");
  });

  it("reports configured state for the selected account instead of any account", async () => {
    const status = await googlechatStatus({
      cfg: {
        channels: {
          googlechat: {
            accounts: {
              default: {
                serviceAccount: { client_email: "default@example.com" },
              },
              alerts: {},
            },
          },
        },
      } as OpenClawConfig,
      accountOverrides: {
        googlechat: "alerts",
      },
      options: {},
    });

    expect(status.configured).toBe(false);
  });

  it("reports configured state for the configured defaultAccount instead of any account", async () => {
    const status = await googlechatStatus({
      cfg: {
        channels: {
          googlechat: {
            defaultAccount: "alerts",
            accounts: {
              default: {
                serviceAccount: { client_email: "default@example.com" },
              },
              alerts: {},
            },
          },
        },
      } as OpenClawConfig,
      accountOverrides: {},
      options: {},
    });

    expect(status.configured).toBe(false);
  });

  it("reports account-scoped config keys for named accounts", () => {
    expect(googlechatSetupWizard.dmPolicy?.resolveConfigKeys?.({}, "alerts")).toEqual({
      policyKey: "channels.googlechat.accounts.alerts.dm.policy",
      allowFromKey: "channels.googlechat.accounts.alerts.dm.allowFrom",
    });
  });

  it("uses configured defaultAccount for omitted DM policy account context", () => {
    const cfg = {
      channels: {
        googlechat: {
          defaultAccount: "alerts",
          dm: {
            policy: "disabled",
          },
          accounts: {
            alerts: {
              serviceAccount: { client_email: "bot@example.com" },
              dm: {
                policy: "allowlist",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(googlechatSetupWizard.dmPolicy?.getCurrent(cfg)).toBe("allowlist");
    expect(googlechatSetupWizard.dmPolicy?.resolveConfigKeys?.(cfg)).toEqual({
      policyKey: "channels.googlechat.accounts.alerts.dm.policy",
      allowFromKey: "channels.googlechat.accounts.alerts.dm.allowFrom",
    });

    const next = googlechatSetupWizard.dmPolicy?.setPolicy(cfg, "open");
    expect(next?.channels?.googlechat?.dm?.policy).toBe("disabled");
    expect(next?.channels?.googlechat?.accounts?.alerts?.dm?.policy).toBe("open");
  });

  it("uses configured defaultAccount for omitted allowFrom prompt context", async () => {
    const prompter = {
      note: vi.fn(async () => {}),
      text: vi.fn(async () => "users/123456789"),
    };

    const next = await googlechatSetupWizard.dmPolicy?.promptAllowFrom?.({
      cfg: {
        channels: {
          googlechat: {
            defaultAccount: "alerts",
            dm: {
              allowFrom: ["users/root"],
            },
            accounts: {
              alerts: {
                serviceAccount: { client_email: "bot@example.com" },
                dm: {
                  allowFrom: ["users/alerts"],
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      prompter: prompter as any,
    });

    expect(next?.channels?.googlechat?.dm?.allowFrom).toEqual(["users/root"]);
    expect(next?.channels?.googlechat?.accounts?.alerts?.dm?.allowFrom).toEqual([
      "users/123456789",
    ]);
  });

  it('writes open DM policy to the named account and preserves inherited allowFrom with "*"', () => {
    const next = googlechatSetupWizard.dmPolicy?.setPolicy(
      {
        channels: {
          googlechat: {
            dm: {
              allowFrom: ["users/123"],
            },
            accounts: {
              alerts: {
                serviceAccount: { client_email: "bot@example.com" },
              },
            },
          },
        },
      } as OpenClawConfig,
      "open",
      "alerts",
    );

    expect(next?.channels?.googlechat?.dm?.policy).toBeUndefined();
    expect(next?.channels?.googlechat?.accounts?.alerts?.dm?.policy).toBe("open");
    expect(next?.channels?.googlechat?.accounts?.alerts?.dm?.allowFrom).toEqual(["users/123", "*"]);
  });

  it("keeps startAccount pending until abort, then unregisters", async () => {
    const unregister = vi.fn();
    hoisted.startGoogleChatMonitor.mockResolvedValue(unregister);

    const { abort, patches, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: startGoogleChatGatewayAccount,
      account: buildAccount(),
    });
    await expectPendingUntilAbort({
      waitForStarted: waitForGoogleChatMonitorStarted,
      isSettled,
      abort,
      task,
      assertBeforeAbort: () => {
        expect(unregister).not.toHaveBeenCalled();
      },
      assertAfterAbort: () => {
        expect(unregister).toHaveBeenCalledOnce();
      },
    });
    expectLifecyclePatch(patches, { running: true });
    expectLifecyclePatch(patches, { running: false });
  });
});

describe("resolveGoogleChatAccount", () => {
  it("parses default-account env JSON credentials only when they decode to an object", () => {
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", '{"client_email":"bot@example.com"}');

    const resolved = resolveGoogleChatAccount({
      cfg: { channels: { googlechat: {} } },
      accountId: "default",
    });

    expect(resolved.credentialSource).toBe("env");
    expect(resolved.credentials).toEqual({ client_email: "bot@example.com" });
  });

  it("ignores env JSON credentials when they decode to a non-object value", () => {
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", '["not","an","object"]');
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT_FILE", "/tmp/googlechat.json");

    const resolved = resolveGoogleChatAccount({
      cfg: { channels: { googlechat: {} } },
      accountId: "default",
    });

    expect(resolved.credentialSource).toBe("env");
    expect(resolved.credentials).toBeUndefined();
    expect(resolved.credentialsFile).toBe("/tmp/googlechat.json");
  });

  it("inherits shared defaults from accounts.default for named accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            default: {
              audienceType: "app-url",
              audience: "https://example.com/googlechat",
              webhookPath: "/googlechat",
            },
            andy: {
              serviceAccountFile: "/tmp/andy-sa.json",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "andy" });
    expect(resolved.config.audienceType).toBe("app-url");
    expect(resolved.config.audience).toBe("https://example.com/googlechat");
    expect(resolved.config.webhookPath).toBe("/googlechat");
    expect(resolved.config.serviceAccountFile).toBe("/tmp/andy-sa.json");
  });

  it("prefers top-level and account overrides over accounts.default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          audienceType: "project-number",
          audience: "1234567890",
          accounts: {
            default: {
              audienceType: "app-url",
              audience: "https://default.example.com/googlechat",
              webhookPath: "/googlechat-default",
            },
            april: {
              webhookPath: "/googlechat-april",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "april" });
    expect(resolved.config.audienceType).toBe("project-number");
    expect(resolved.config.audience).toBe("1234567890");
    expect(resolved.config.webhookPath).toBe("/googlechat-april");
  });

  it("does not inherit disabled state from accounts.default for named accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            default: {
              enabled: false,
              audienceType: "app-url",
              audience: "https://example.com/googlechat",
            },
            andy: {
              serviceAccountFile: "/tmp/andy-sa.json",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "andy" });
    expect(resolved.enabled).toBe(true);
    expect(resolved.config.enabled).toBeUndefined();
    expect(resolved.config.audienceType).toBe("app-url");
  });

  it("does not inherit default-account credentials into named accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            default: {
              serviceAccountRef: {
                source: "env",
                provider: "test",
                id: "default-sa",
              },
              audienceType: "app-url",
              audience: "https://example.com/googlechat",
            },
            andy: {
              serviceAccountFile: "/tmp/andy-sa.json",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "andy" });
    expect(resolved.credentialSource).toBe("file");
    expect(resolved.credentialsFile).toBe("/tmp/andy-sa.json");
    expect(resolved.config.audienceType).toBe("app-url");
  });

  it("does not inherit dangerous name matching from accounts.default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            default: {
              dangerouslyAllowNameMatching: true,
              audienceType: "app-url",
              audience: "https://example.com/googlechat",
            },
            andy: {
              serviceAccountFile: "/tmp/andy-sa.json",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "andy" });
    expect(resolved.config.dangerouslyAllowNameMatching).toBeUndefined();
    expect(resolved.config.audienceType).toBe("app-url");
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          defaultAccount: "alerts",
          accounts: {
            alerts: {
              serviceAccountFile: "/tmp/alerts-sa.json",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg });
    expect(resolved.accountId).toBe("alerts");
    expect(resolved.credentialSource).toBe("file");
    expect(resolved.credentialsFile).toBe("/tmp/alerts-sa.json");
  });
});
