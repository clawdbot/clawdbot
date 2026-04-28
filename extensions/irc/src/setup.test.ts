import {
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "openclaw/plugin-sdk/channel-test-helpers";
import {
  createPluginSetupWizardAdapter,
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  promptSetupWizardAllowFrom,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listIrcAccountIds,
  resolveDefaultIrcAccountId,
  type ResolvedIrcAccount,
} from "./accounts.js";
import { startIrcGatewayAccount } from "./gateway.js";
import { clearIrcRuntime, setIrcRuntime } from "./runtime.js";
import {
  ircSetupAdapter,
  parsePort,
  setIrcAllowFrom,
  setIrcDmPolicy,
  setIrcGroupAccess,
  setIrcNickServ,
  updateIrcAccountConfig,
} from "./setup-core.js";
import { ircSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

const hoisted = vi.hoisted(() => ({
  monitorIrcProvider: vi.fn(),
  sendMessageIrc: vi.fn(),
}));

vi.mock("./channel-runtime.js", () => {
  return {
    monitorIrcProvider: hoisted.monitorIrcProvider,
    sendMessageIrc: hoisted.sendMessageIrc,
  };
});

const ircSetupPlugin = {
  id: "irc",
  meta: {
    label: "IRC",
  },
  config: {
    defaultAccountId: resolveDefaultIrcAccountId,
    listAccountIds: listIrcAccountIds,
  },
  setupWizard: ircSetupWizard,
} as never;

const ircConfigureAdapter = createPluginSetupWizardAdapter(ircSetupPlugin);
const ircStatus = createPluginSetupWizardStatus(ircSetupPlugin);

function buildAccount(): ResolvedIrcAccount {
  return {
    accountId: "default",
    enabled: true,
    name: "default",
    configured: true,
    host: "irc.example.com",
    port: 6697,
    tls: true,
    nick: "openclaw",
    username: "openclaw",
    realname: "OpenClaw",
    password: "",
    passwordSource: "none",
    config: {} as ResolvedIrcAccount["config"],
  };
}

function installIrcRuntime() {
  setIrcRuntime({
    logging: {
      shouldLogVerbose: vi.fn(() => false),
      getChildLogger: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
    },
    channel: {
      activity: {
        record: vi.fn(),
        get: vi.fn(),
      },
    },
  } as never);
}

describe("irc setup", () => {
  afterEach(() => {
    vi.clearAllMocks();
    clearIrcRuntime();
  });

  it("parses valid ports and falls back for invalid values", () => {
    expect(parsePort("6697", 6667)).toBe(6697);
    expect(parsePort(" 7000 ", 6667)).toBe(7000);
    expect(parsePort("", 6667)).toBe(6667);
    expect(parsePort("70000", 6667)).toBe(6667);
    expect(parsePort("abc", 6667)).toBe(6667);
  });

  it("updates top-level dm policy and allowlist", () => {
    const cfg: CoreConfig = { channels: { irc: {} } };

    expect(setIrcDmPolicy(cfg, "open")).toMatchObject({
      channels: {
        irc: {
          dmPolicy: "open",
        },
      },
    });

    expect(setIrcAllowFrom(cfg, ["alice", "bob"])).toMatchObject({
      channels: {
        irc: {
          allowFrom: ["alice", "bob"],
        },
      },
    });
  });

  it("setup status honors the selected named account", async () => {
    const status = await ircStatus({
      cfg: {
        channels: {
          irc: {
            accounts: {
              ops: {
                host: "irc.example.com",
                nick: "ops-bot",
              },
              work: {
                host: "irc.example.com",
              },
            },
          },
        },
      } as CoreConfig,
      accountOverrides: {
        irc: "work",
      },
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toEqual(["IRC: needs host + nick"]);
  });

  it("setup status honors the configured default account", async () => {
    const status = await ircStatus({
      cfg: {
        channels: {
          irc: {
            defaultAccount: "work",
            accounts: {
              ops: {
                host: "irc.example.com",
                nick: "ops-bot",
              },
              work: {
                host: "irc.example.com",
                nick: "",
              },
            },
          },
        },
      } as CoreConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toEqual(["IRC: needs host + nick"]);
  });

  it("stores nickserv and account config patches on the scoped account", () => {
    const cfg: CoreConfig = { channels: { irc: {} } };

    expect(
      setIrcNickServ(cfg, "work", {
        enabled: true,
        service: "NickServ",
      }),
    ).toMatchObject({
      channels: {
        irc: {
          accounts: {
            work: {
              nickserv: {
                enabled: true,
                service: "NickServ",
              },
            },
          },
        },
      },
    });

    expect(
      updateIrcAccountConfig(cfg, "work", {
        host: "irc.libera.chat",
        nick: "openclaw-work",
      }),
    ).toMatchObject({
      channels: {
        irc: {
          accounts: {
            work: {
              host: "irc.libera.chat",
              nick: "openclaw-work",
            },
          },
        },
      },
    });
  });

  it("normalizes allowlist groups and handles non-allowlist policies", () => {
    const cfg: CoreConfig = { channels: { irc: {} } };

    expect(
      setIrcGroupAccess(
        cfg,
        "default",
        "allowlist",
        ["openclaw", "#ops", "openclaw", "*"],
        (raw) => {
          const trimmed = raw.trim();
          if (!trimmed) {
            return null;
          }
          if (trimmed === "*") {
            return "*";
          }
          return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
        },
      ),
    ).toMatchObject({
      channels: {
        irc: {
          enabled: true,
          groupPolicy: "allowlist",
          groups: {
            "#openclaw": {},
            "#ops": {},
            "*": {},
          },
        },
      },
    });

    expect(setIrcGroupAccess(cfg, "default", "disabled", [], () => null)).toMatchObject({
      channels: {
        irc: {
          enabled: true,
          groupPolicy: "disabled",
        },
      },
    });
  });

  it("validates required input and applies normalized account config", () => {
    const validateInput = ircSetupAdapter.validateInput;
    const applyAccountConfig = ircSetupAdapter.applyAccountConfig;
    expect(validateInput).toBeTypeOf("function");
    expect(applyAccountConfig).toBeTypeOf("function");

    expect(
      validateInput!({
        input: { host: "", nick: "openclaw" },
      } as never),
    ).toBe("IRC requires host.");

    expect(
      validateInput!({
        input: { host: "irc.libera.chat", nick: "" },
      } as never),
    ).toBe("IRC requires nick.");

    expect(
      validateInput!({
        input: { host: "irc.libera.chat", nick: "openclaw" },
      } as never),
    ).toBeNull();

    expect(
      applyAccountConfig({
        cfg: { channels: { irc: {} } },
        accountId: "default",
        input: {
          name: "Default",
          host: " irc.libera.chat ",
          port: "7000",
          tls: true,
          nick: " openclaw ",
          username: " claw ",
          realname: " OpenClaw Bot ",
          password: " secret ",
          channels: ["#openclaw"],
        },
      } as never),
    ).toEqual({
      channels: {
        irc: {
          enabled: true,
          name: "Default",
          host: "irc.libera.chat",
          port: 7000,
          tls: true,
          nick: "openclaw",
          username: "claw",
          realname: "OpenClaw Bot",
          password: "secret",
          channels: ["#openclaw"],
        },
      },
    });
  });

  it("configures host and nick via setup prompts", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "IRC server host") {
          return "irc.libera.chat";
        }
        if (message === "IRC server port") {
          return "6697";
        }
        if (message === "IRC nick") {
          return "openclaw-bot";
        }
        if (message === "IRC username") {
          return "openclaw";
        }
        if (message === "IRC real name") {
          return "OpenClaw Bot";
        }
        if (message.startsWith("Auto-join IRC channels")) {
          return "#openclaw, #ops";
        }
        if (message.startsWith("IRC channels allowlist")) {
          return "#openclaw, #ops";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Use TLS for IRC?") {
          return true;
        }
        if (message === "Configure IRC channels access?") {
          return true;
        }
        return false;
      }),
    });

    const result = await runSetupWizardConfigure({
      configure: ircConfigureAdapter.configure,
      cfg: {} as CoreConfig,
      prompter,
      options: {},
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.irc?.enabled).toBe(true);
    expect(result.cfg.channels?.irc?.host).toBe("irc.libera.chat");
    expect(result.cfg.channels?.irc?.nick).toBe("openclaw-bot");
    expect(result.cfg.channels?.irc?.tls).toBe(true);
    expect(result.cfg.channels?.irc?.channels).toEqual(["#openclaw", "#ops"]);
    expect(result.cfg.channels?.irc?.groupPolicy).toBe("allowlist");
    expect(Object.keys(result.cfg.channels?.irc?.groups ?? {})).toEqual(["#openclaw", "#ops"]);
  });

  it("writes DM allowFrom to top-level config for non-default account prompts", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "IRC allowFrom (nick or nick!user@host)") {
          return "Alice, Bob!ident@example.org";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
      confirm: vi.fn(async () => false),
    });

    const promptAllowFrom = ircConfigureAdapter.dmPolicy?.promptAllowFrom;
    if (!promptAllowFrom) {
      throw new Error("promptAllowFrom unavailable");
    }

    const cfg: CoreConfig = {
      channels: {
        irc: {
          accounts: {
            work: {
              host: "irc.libera.chat",
              nick: "openclaw-work",
            },
          },
        },
      },
    };

    const updated = await promptSetupWizardAllowFrom({
      promptAllowFrom,
      cfg,
      prompter,
      accountId: "work",
    });
    expect(updated).toBeDefined();

    expect(updated?.channels?.irc?.allowFrom).toEqual(["alice", "bob!ident@example.org"]);
    expect(updated?.channels?.irc?.accounts?.work?.allowFrom).toBeUndefined();
  });

  it("keeps startAccount pending until abort, then stops the monitor", async () => {
    const stop = vi.fn();
    hoisted.monitorIrcProvider.mockResolvedValue({ stop });
    installIrcRuntime();

    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: async (ctx) =>
        await startIrcGatewayAccount({
          ...ctx,
          cfg: ctx.cfg as CoreConfig,
        }),
      account: buildAccount(),
    });

    await expectStopPendingUntilAbort({
      waitForStarted: waitForStartedMocks(hoisted.monitorIrcProvider),
      isSettled,
      abort,
      task,
      stop,
    });
  });
});
