// Googlechat tests cover setup plugin behavior.
import fs from "node:fs";
import path from "node:path";
import {
  createStartAccountContext,
  expectLifecyclePatch,
  expectPendingUntilAbort,
  installChannelDmPolicyContractSuite,
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
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
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

// The path resolver stays real so the status assertions below cover the whole chain
// from configured webhookUrl to published snapshot; only the monitor is stubbed.
vi.mock("./channel.runtime.js", async () => {
  const monitor = await vi.importActual<typeof import("./monitor.js")>("./monitor.js");
  return {
    googleChatChannelRuntime: {
      resolveGoogleChatWebhookPath: monitor.resolveGoogleChatWebhookPath,
      startGoogleChatMonitor: hoisted.startGoogleChatMonitor,
    },
  };
});

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
  await vi.waitFor(() => expect(hoisted.startGoogleChatMonitor).toHaveBeenCalledOnce());
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

  it("ignores blank service-account env values during setup", async () => {
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", "   ");
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT_FILE", "  ");
    const confirm = vi.fn(async () => true);
    const select = vi.fn(async () => "file" as const) as unknown as WizardPrompter["select"];

    const result = await googlechatSetupWizard.prepare?.({
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      credentialValues: {},
      prompter: createTestWizardPrompter({ confirm, select }),
    } as never);

    expect(confirm).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledOnce();
    expect(result?.credentialValues?.["__googlechatUseEnv"]).toBe("0");
  });

  it("offers valid service-account env credentials for the default account", async () => {
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", '  {"client_email":"bot@example.com"}  ');
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT_FILE", "  ");
    const confirm = vi.fn(async () => true);
    const select = vi.fn(async () => "file" as const) as unknown as WizardPrompter["select"];

    const result = await googlechatSetupWizard.prepare?.({
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      credentialValues: {},
      prompter: createTestWizardPrompter({ confirm, select }),
    } as never);

    expect(confirm).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
    expect(result?.credentialValues?.["__googlechatUseEnv"]).toBe("1");
  });

  it("does not offer default-account env credentials to named accounts", async () => {
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", '{"client_email":"bot@example.com"}');
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT_FILE", "/tmp/googlechat.json");
    const confirm = vi.fn(async () => true);
    const select = vi.fn(async () => "file" as const) as unknown as WizardPrompter["select"];

    const result = await googlechatSetupWizard.prepare?.({
      cfg: {},
      accountId: "alerts",
      credentialValues: {},
      prompter: createTestWizardPrompter({ confirm, select }),
    } as never);

    expect(confirm).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledOnce();
    expect(result?.credentialValues?.["__googlechatUseEnv"]).toBe("0");
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

  installChannelDmPolicyContractSuite({
    dmPolicy: googlechatSetupWizard.dmPolicy!,
    cases: [
      {
        name: "Google Chat named accounts",
        channel: "googlechat",
        accountId: "alerts",
        accountConfig: { serviceAccount: { client_email: "bot@example.com" } },
        inheritedAllowFrom: ["users/123"],
        defaultAccount: {},
      },
    ],
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

  it("uses configured defaultAccount for omitted allowFrom prompt context", async () => {
    const prompter = createTestWizardPrompter({
      note: vi.fn(async () => {}),
      text: vi.fn(async () => "users/123456789"),
    });

    const next = await googlechatSetupWizard.dmPolicy?.promptAllowFrom?.({
      cfg: {
        channels: {
          googlechat: {
            defaultAccount: "alerts",
            allowFrom: ["users/root"],
            accounts: {
              alerts: {
                serviceAccount: { client_email: "bot@example.com" },
                allowFrom: ["users/alerts"],
              },
            },
          },
        },
      } as OpenClawConfig,
      prompter,
    });

    expect(next?.channels?.googlechat?.allowFrom).toEqual(["users/root"]);
    expect(next?.channels?.googlechat?.accounts?.alerts?.allowFrom).toEqual(["users/123456789"]);
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

  it("publishes the bound webhook path when the account resolves one", async () => {
    hoisted.startGoogleChatMonitor.mockResolvedValue(vi.fn());

    const { abort, patches, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: startGoogleChatGatewayAccount,
      account: buildAccount(),
    });
    await expectPendingUntilAbort({
      waitForStarted: waitForGoogleChatMonitorStarted,
      isSettled,
      abort,
      task,
    });

    expectLifecyclePatch(patches, {
      running: true,
      webhookPath: "/googlechat",
      lifecycle: "starting",
    });
    expect(patches.some((patch) => patch.lifecycle === "blocked")).toBe(false);
  });

  it("reports a blocked lifecycle when the configured webhookUrl resolves to no path", async () => {
    hoisted.startGoogleChatMonitor.mockResolvedValue(vi.fn());
    const account = buildAccount();

    const { abort, patches, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: startGoogleChatGatewayAccount,
      account: {
        ...account,
        config: {
          ...account.config,
          webhookPath: undefined,
          webhookUrl: "chat.example.com/googlechat",
        },
      },
    });
    await expectPendingUntilAbort({
      waitForStarted: waitForGoogleChatMonitorStarted,
      isSettled,
      abort,
      task,
    });

    const startPatch = patches.find((patch) => patch.running === true);
    expect(startPatch).toBeDefined();
    expect(startPatch?.lifecycle).toBe("blocked");
    expect(startPatch?.lastError).toContain("webhookUrl");
    // The account must not advertise a route the monitor never registered.
    expect(startPatch?.webhookPath).toBeUndefined();
  });

  it("clears a previously published webhook path when a restart resolves none", async () => {
    hoisted.startGoogleChatMonitor.mockResolvedValue(vi.fn());
    const account = buildAccount();
    const resolvable = {
      ...account,
      config: {
        ...account.config,
        webhookPath: undefined,
        webhookUrl: "https://chat.example.com/gc-inbound",
      },
    };
    const firstAbort = new AbortController();
    // One context, so both starts write through the same status snapshot the way
    // the gateway's runtime store patch-merges successive plugin patches.
    const ctx = createStartAccountContext({
      account: resolvable,
      abortSignal: firstAbort.signal,
    });
    const firstRun = startGoogleChatGatewayAccount(ctx);
    await waitForGoogleChatMonitorStarted();
    expect(ctx.getStatus().webhookPath).toBe("/gc-inbound");
    firstAbort.abort();
    await firstRun;

    hoisted.startGoogleChatMonitor.mockClear();
    const secondAbort = new AbortController();
    const secondRun = startGoogleChatGatewayAccount({
      ...ctx,
      account: {
        ...resolvable,
        config: { ...resolvable.config, webhookUrl: "chat.example.com/gc-inbound" },
      },
      abortSignal: secondAbort.signal,
    });
    await waitForGoogleChatMonitorStarted();

    const restarted = ctx.getStatus();
    expect(restarted.lifecycle).toBe("blocked");
    expect(restarted.webhookPath).toBeUndefined();
    secondAbort.abort();
    await secondRun;
  });

  it("clears running status when monitor startup fails", async () => {
    hoisted.startGoogleChatMonitor.mockRejectedValue(new Error("webhook bind failed"));
    const patches: ChannelAccountSnapshot[] = [];

    const task = startGoogleChatGatewayAccount(
      createStartAccountContext({
        account: buildAccount(),
        statusPatchSink: (next) => patches.push({ ...next }),
      }),
    );

    await expect(task).rejects.toThrow("webhook bind failed");
    expectLifecyclePatch(patches, { running: true });
    expectLifecyclePatch(patches, { running: false });
  });
});

describe("resolveGoogleChatAccount", () => {
  const tempWorkspaces: TempWorkspaceSync[] = [];

  afterEach(() => {
    for (const workspace of tempWorkspaces.splice(0)) {
      workspace.cleanup();
    }
  });

  it("resolves user-relative service-account files before checking availability", () => {
    const workspace = tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-googlechat-home-",
    });
    tempWorkspaces.push(workspace);
    const homeDir = workspace.dir;
    fs.writeFileSync(path.join(homeDir, "service-account.json"), "{}", { mode: 0o600 });
    vi.stubEnv("OPENCLAW_HOME", homeDir);
    try {
      const resolved = resolveGoogleChatAccount({
        cfg: {
          channels: {
            googlechat: {
              serviceAccountFile: "~/service-account.json",
            },
          },
        },
        accountId: "default",
      });

      expect(resolved.credentialSource).toBe("file");
      expect(resolved.credentialsFile).toBe("~/service-account.json");
      expect(resolved.tokenStatus).toBe("available");
    } finally {
      vi.unstubAllEnvs();
    }
  });

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
    const workspace = tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-googlechat-missing-",
    });
    tempWorkspaces.push(workspace);
    const missingFile = path.join(workspace.dir, "missing.json");
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", '["not","an","object"]');
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT_FILE", missingFile);

    const resolved = resolveGoogleChatAccount({
      cfg: { channels: { googlechat: {} } },
      accountId: "default",
    });

    expect(resolved.credentialSource).toBe("env");
    expect(resolved.credentials).toBeUndefined();
    expect(resolved.credentialsFile).toBe(missingFile);
    expect(resolved.tokenStatus).toBe("configured_unavailable");
    expect(resolved.credentialDiagnostics).toEqual([
      {
        code: "CREDENTIAL_FILE_UNAVAILABLE",
        path: "env.GOOGLE_CHAT_SERVICE_ACCOUNT_FILE",
        reason: "not-found",
      },
    ]);
    expect(JSON.stringify(resolved.credentialDiagnostics)).not.toContain(missingFile);
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

  it("merges account bot loop protection over top-level defaults field-by-field", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          botLoopProtection: {
            maxEventsPerWindow: 8,
            windowSeconds: 120,
            cooldownSeconds: 240,
          },
          accounts: {
            april: {
              webhookPath: "/googlechat-april",
              botLoopProtection: {
                maxEventsPerWindow: 3,
              },
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "april" });
    expect(resolved.config.botLoopProtection).toEqual({
      maxEventsPerWindow: 3,
      windowSeconds: 120,
      cooldownSeconds: 240,
    });
  });

  it("merges account bot loop protection over accounts.default field-by-field", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            default: {
              webhookPath: "/googlechat",
              botLoopProtection: {
                windowSeconds: 120,
                cooldownSeconds: 240,
              },
            },
            april: {
              webhookPath: "/googlechat-april",
              botLoopProtection: {
                maxEventsPerWindow: 3,
              },
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "april" });
    expect(resolved.config.botLoopProtection).toEqual({
      maxEventsPerWindow: 3,
      windowSeconds: 120,
      cooldownSeconds: 240,
    });
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
              serviceAccount: {
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
