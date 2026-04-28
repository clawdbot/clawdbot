import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, OpenClawPluginApi } from "../runtime-api.js";

const resolveMattermostAccount = vi.hoisted(() => vi.fn());
const normalizeMattermostBaseUrl = vi.hoisted(() => vi.fn((value: string | undefined) => value));
const hasConfiguredSecretInput = vi.hoisted(() => vi.fn((value: unknown) => Boolean(value)));

vi.mock("./setup.accounts.runtime.js", () => ({
  listMattermostAccountIds: vi.fn((cfg: OpenClawConfig) => {
    const accounts = cfg.channels?.mattermost?.accounts;
    const ids = accounts ? Object.keys(accounts) : [];
    return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
  }),
  resolveMattermostAccount: (params: Parameters<typeof resolveMattermostAccount>[0]) => {
    const mocked = resolveMattermostAccount(params);
    return (
      mocked ?? {
        accountId: params.accountId ?? DEFAULT_ACCOUNT_ID,
        enabled: params.cfg.channels?.mattermost?.enabled !== false,
        botToken:
          typeof params.cfg.channels?.mattermost?.botToken === "string"
            ? params.cfg.channels.mattermost.botToken
            : undefined,
        baseUrl: normalizeMattermostBaseUrl(params.cfg.channels?.mattermost?.baseUrl),
        botTokenSource:
          typeof params.cfg.channels?.mattermost?.botToken === "string" ? "config" : "none",
        baseUrlSource: params.cfg.channels?.mattermost?.baseUrl ? "config" : "none",
        config: params.cfg.channels?.mattermost ?? {},
      }
    );
  },
}));

vi.mock("./setup.client.runtime.js", () => ({
  normalizeMattermostBaseUrl,
}));

vi.mock("./setup.secret-input.runtime.js", () => ({
  hasConfiguredSecretInput,
}));

function createApi(
  registrationMode: OpenClawPluginApi["registrationMode"],
  registerHttpRoute = vi.fn(),
): OpenClawPluginApi {
  return createTestPluginApi({
    id: "mattermost",
    name: "Mattermost",
    source: "test",
    config: {},
    runtime: {} as OpenClawPluginApi["runtime"],
    registrationMode,
    registerHttpRoute,
  });
}

let plugin: typeof import("../index.js").default;
let mattermostSetupWizard: typeof import("./setup-surface.js").mattermostSetupWizard;
let isMattermostConfigured: typeof import("./setup-core.js").isMattermostConfigured;
let resolveMattermostAccountWithSecrets: typeof import("./setup-core.js").resolveMattermostAccountWithSecrets;
let mattermostSetupAdapter: typeof import("./setup-core.js").mattermostSetupAdapter;

describe("mattermost setup", () => {
  beforeAll(async () => {
    ({ mattermostSetupWizard } = await import("./setup-surface.js"));
    ({ isMattermostConfigured, resolveMattermostAccountWithSecrets, mattermostSetupAdapter } =
      await import("./setup-core.js"));
    plugin = {
      register(api: OpenClawPluginApi) {
        if (api.registrationMode === "full") {
          api.registerHttpRoute({
            path: "/api/channels/mattermost/command",
            auth: "plugin",
            handler: async () => true,
          });
        }
      },
    } as typeof plugin;
  });

  beforeEach(() => {
    registerEnvDefaults();
  });

  afterEach(() => {
    resolveMattermostAccount.mockReset();
    normalizeMattermostBaseUrl.mockReset();
    normalizeMattermostBaseUrl.mockImplementation((value: string | undefined) => value);
    hasConfiguredSecretInput.mockReset();
    hasConfiguredSecretInput.mockImplementation((value: unknown) => Boolean(value));
    vi.unstubAllEnvs();
  });

  it("reports configuration only when token and base url are both present", () => {
    expect(
      isMattermostConfigured({
        botToken: "bot-token",
        baseUrl: "https://chat.example.com",
        config: {},
      } as never),
    ).toBe(true);

    expect(
      isMattermostConfigured({
        botToken: "",
        baseUrl: "https://chat.example.com",
        config: { botToken: "secret-ref" },
      } as never),
    ).toBe(true);

    expect(
      isMattermostConfigured({
        botToken: "",
        baseUrl: "",
        config: {},
      } as never),
    ).toBe(false);
  });

  it("resolves accounts with unresolved secret refs allowed", () => {
    resolveMattermostAccount.mockReturnValue({ accountId: "default" });

    const cfg = { channels: { mattermost: {} } };

    expect(resolveMattermostAccountWithSecrets(cfg as never, "default")).toEqual({
      accountId: "default",
    });
    expect(resolveMattermostAccount).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      allowUnresolvedSecretRef: true,
    });
  });

  it("validates env and explicit credential requirements", () => {
    const validateInput = mattermostSetupAdapter.validateInput;
    expect(validateInput).toBeTypeOf("function");

    expect(
      validateInput!({
        accountId: "secondary",
        input: { useEnv: true },
      } as never),
    ).toBe("Mattermost env vars can only be used for the default account.");

    normalizeMattermostBaseUrl.mockReturnValue(undefined);
    expect(
      validateInput!({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { useEnv: false, botToken: "tok", httpUrl: "not-a-url" },
      } as never),
    ).toBe("Mattermost requires --bot-token and --http-url (or --use-env).");

    normalizeMattermostBaseUrl.mockReturnValue("https://chat.example.com");
    expect(
      validateInput!({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { useEnv: false, botToken: "tok", httpUrl: "https://chat.example.com" },
      } as never),
    ).toBeNull();
  });

  it("applies normalized config for default and named accounts", () => {
    normalizeMattermostBaseUrl.mockReturnValue("https://chat.example.com");
    const applyAccountConfig = mattermostSetupAdapter.applyAccountConfig;
    expect(applyAccountConfig).toBeTypeOf("function");

    expect(
      applyAccountConfig({
        cfg: { channels: { mattermost: {} } },
        accountId: DEFAULT_ACCOUNT_ID,
        input: {
          name: "Default",
          botToken: "tok",
          httpUrl: "https://chat.example.com",
        },
      } as never),
    ).toEqual({
      channels: {
        mattermost: {
          enabled: true,
          name: "Default",
          botToken: "tok",
          baseUrl: "https://chat.example.com",
        },
      },
    });

    expect(
      applyAccountConfig({
        cfg: {
          channels: {
            mattermost: {
              name: "Legacy",
            },
          },
        },
        accountId: "Work Team",
        input: {
          name: "Work",
          botToken: "tok2",
          httpUrl: "https://chat.example.com",
        },
      } as never),
    ).toMatchObject({
      channels: {
        mattermost: {
          accounts: {
            default: { name: "Legacy" },
            "work-team": {
              enabled: true,
              name: "Work",
              botToken: "tok2",
              baseUrl: "https://chat.example.com",
            },
          },
        },
      },
    });
  });

  it.each([
    { name: "skips slash callback registration in setup-only mode", mode: "setup-only" as const },
    { name: "registers slash callback routes in full mode", mode: "full" as const },
  ])("$name", ({ mode }) => {
    const registerHttpRoute = vi.fn();

    plugin.register(createApi(mode, registerHttpRoute));

    if (mode === "setup-only") {
      expect(registerHttpRoute).not.toHaveBeenCalled();
      return;
    }

    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    expect(registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/channels/mattermost/command",
        auth: "plugin",
      }),
    );
  });

  it("treats secret-ref tokens plus base url as configured", async () => {
    const configured = await mattermostSetupWizard.status.resolveConfigured({
      cfg: {
        channels: {
          mattermost: {
            baseUrl: "https://chat.example.com",
            botToken: {
              source: "env",
              provider: "default",
              id: "MATTERMOST_BOT_TOKEN",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(configured).toBe(true);
  });

  it("does not inherit configured state from a sibling when defaultAccount is named", async () => {
    const configured = await mattermostSetupWizard.status.resolveConfigured({
      cfg: {
        channels: {
          mattermost: {
            defaultAccount: "work",
            accounts: {
              alerts: {
                baseUrl: "https://chat.example.com",
                botToken: {
                  source: "env",
                  provider: "default",
                  id: "MATTERMOST_BOT_TOKEN",
                },
              },
              work: {},
            },
          },
        },
      } as OpenClawConfig,
      accountId: undefined,
    });

    expect(configured).toBe(false);
  });

  it("shows intro note only when the target account is not configured", () => {
    expect(
      mattermostSetupWizard.introNote?.shouldShow?.({
        cfg: {
          channels: {
            mattermost: {},
          },
        } as OpenClawConfig,
        accountId: "default",
      } as never),
    ).toBe(true);

    expect(
      mattermostSetupWizard.introNote?.shouldShow?.({
        cfg: {
          channels: {
            mattermost: {
              baseUrl: "https://chat.example.com",
              botToken: {
                source: "env",
                provider: "default",
                id: "MATTERMOST_BOT_TOKEN",
              },
            },
          },
        } as OpenClawConfig,
        accountId: "default",
      } as never),
    ).toBe(false);
  });

  it("offers env shortcut only for the default account when env is present and config is empty", () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", "bot-token");
    vi.stubEnv("MATTERMOST_URL", "https://chat.example.com");

    expect(
      mattermostSetupWizard.envShortcut?.isAvailable?.({
        cfg: { channels: { mattermost: {} } } as OpenClawConfig,
        accountId: "default",
      } as never),
    ).toBe(true);

    expect(
      mattermostSetupWizard.envShortcut?.isAvailable?.({
        cfg: { channels: { mattermost: {} } } as OpenClawConfig,
        accountId: "work",
      } as never),
    ).toBe(false);
  });

  it("keeps env shortcut as a no-op patch for the selected account", () => {
    expect(
      mattermostSetupWizard.envShortcut?.apply?.({
        cfg: { channels: { mattermost: { enabled: false } } } as OpenClawConfig,
        accountId: "default",
      } as never),
    ).toEqual({
      channels: {
        mattermost: {
          enabled: true,
        },
      },
    });
  });
});

function registerEnvDefaults() {
  vi.unstubAllEnvs();
}
