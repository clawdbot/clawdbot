// Signal tests cover setup adapter integration with account-owned transport policy.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  type ChannelSetupAdapter,
  moveSingleAccountChannelSectionToDefaultAccount,
} from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCompatibilityConfig } from "../doctor-contract-api.js";
import { resolveSignalAccount } from "./accounts.js";
import {
  createSignalCliPathTextInput,
  signalSetupAdapter,
  signalSetupContract,
} from "./setup-core.js";
import { signalSetupWizard } from "./setup-surface.js";

const detectSignalTransportMock = vi.hoisted(() => vi.fn());

vi.mock("./setup-transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./setup-transport.js")>();
  return { ...actual, detectSignalTransport: detectSignalTransportMock };
});

async function prepareInput(
  input: {
    signalNumber?: string;
    signalTransport?: "external-native" | "container";
    httpUrl?: string;
  },
  cfg: OpenClawConfig = {},
) {
  const prepared = await signalSetupAdapter.prepareAccountConfigInput?.({
    cfg,
    accountId: "default",
    input,
    runtime: {} as never,
  });
  if (!prepared) {
    throw new Error("expected prepared Signal setup input");
  }
  return prepared;
}

function defaultAliasConfig(rootExtras: Record<string, unknown> = {}): OpenClawConfig {
  return {
    channels: {
      signal: {
        account: "+15555550100",
        transport: { kind: "container", url: "http://signal-container:8080" },
        accounts: { "Default.": { account: "", name: "Existing", textChunkLimit: 123 } },
        ...rootExtras,
      },
    },
  } as never;
}

/** Setup results are only useful once they survive the config writer's serialize and reread. */
function reload(cfg: OpenClawConfig | undefined): OpenClawConfig {
  const persisted = JSON.stringify(cfg ?? {});
  return JSON.parse(persisted) as OpenClawConfig;
}

/**
 * A named add promotes single-account root keys into the map before the adapter writes
 * (src/channels/plugins/account-config-mutation.ts:141-152); calling the adapter alone skips it.
 * The CLI hands the promotion the setup contract, not the adapter (account-config-mutation.ts:69
 * and :145), so the contract has to forward Signal's declarations for the writer to see them.
 */
function addNamedAccount(
  cfg: OpenClawConfig,
  accountId: string,
  input: { signalTransport?: "external-native" | "container"; httpUrl?: string },
) {
  const promoted = moveSingleAccountChannelSectionToDefaultAccount({
    cfg,
    channelKey: "signal",
    setupSurface: signalSetupContract as ChannelSetupAdapter,
  });
  return signalSetupAdapter.applyAccountConfig?.({ cfg: promoted, accountId, input });
}

const externalNativeInput = {
  signalTransport: "external-native" as const,
  httpUrl: "http://127.0.0.1:9299",
};

describe("signalSetupAdapter", () => {
  beforeEach(() => {
    detectSignalTransportMock.mockReset();
  });

  it("uses setup-time container detection for a bare HTTP URL", async () => {
    detectSignalTransportMock.mockResolvedValue({
      kind: "container",
      url: "http://signal:8080",
    });

    const input = await prepareInput({
      signalNumber: "+15555550123",
      httpUrl: "http://signal:8080",
    });
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {},
      accountId: "default",
      input,
    });

    expect(detectSignalTransportMock).toHaveBeenCalledWith({
      url: "http://signal:8080",
      account: "+15555550123",
    });
    expect(next?.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://signal:8080",
    });
  });

  it("requires an explicit kind when bare HTTP URL detection is unreachable", async () => {
    detectSignalTransportMock.mockRejectedValue(new Error("unreachable"));

    await expect(prepareInput({ httpUrl: "http://signal:8080" })).rejects.toThrow(
      "Signal could not detect the HTTP transport; start the endpoint or pass --signal-transport external-native|container.",
    );
  });

  it("preserves an existing container account when detection is unreachable", async () => {
    detectSignalTransportMock.mockRejectedValue(new Error("unreachable"));
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "container", url: "http://signal-old:8080" },
        },
      },
    };

    const input = await prepareInput({ httpUrl: "http://signal-new:8080" }, cfg);
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg,
      accountId: "default",
      input,
    });

    expect(input.signalTransport).toBeUndefined();
    expect(next?.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://signal-new:8080",
    });
  });

  it("skips setup-time detection for an explicit transport kind", async () => {
    const input = await prepareInput({
      signalNumber: "+15555550123",
      signalTransport: "container",
      httpUrl: "http://signal:8080",
    });

    expect(input.signalTransport).toBe("container");
    expect(detectSignalTransportMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      accountId: "default",
      signalNumber: " +1 (555) 555-0123 ",
      expectedAccount: "+15555550123",
    },
    {
      accountId: "work",
      signalNumber: "signal: +1 (555) 555-0124",
      expectedAccount: "+15555550124",
    },
    { accountId: "default", signalNumber: "15555550125", expectedAccount: "+15555550125" },
    { accountId: "work", signalNumber: "+12345", expectedAccount: "+12345" },
    {
      accountId: "default",
      signalNumber: "+123456789012345",
      expectedAccount: "+123456789012345",
    },
  ])(
    "stores the canonical Signal number for the $accountId account",
    ({ accountId, signalNumber, expectedAccount }) => {
      const next = signalSetupAdapter.applyAccountConfig?.({
        cfg: {},
        accountId,
        input: { signalNumber },
      });
      const account =
        accountId === "default"
          ? next?.channels?.signal?.account
          : next?.channels?.signal?.accounts?.[accountId]?.account;

      expect(account).toBe(expectedAccount);
    },
  );

  it("restores a generically promoted default account before writing a named account", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            transport: { kind: "managed-native", httpPort: 8080 },
            accounts: {
              default: { account: "+15555550123" },
            },
          },
        },
      },
      accountId: "work",
      input: { signalNumber: "+15555550124" },
    });

    expect(next?.channels?.signal?.account).toBe("+15555550123");
    expect(next?.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      httpPort: 8080,
    });
    expect(next?.channels?.signal?.accounts?.default).toBeUndefined();
    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "managed-native",
      httpHost: "127.0.0.1",
      httpPort: 8081,
    });
  });

  it("keeps promoted default-account policy scoped to that account", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            dmPolicy: "pairing",
            transport: { kind: "managed-native", httpPort: 8080 },
            accounts: {
              default: {
                account: "+15555550123",
                dmPolicy: "disabled",
                allowFrom: ["+15555550125"],
              },
            },
          },
        },
      },
      accountId: "work",
      input: { signalNumber: "+15555550124" },
    });

    expect(next?.channels?.signal?.account).toBe("+15555550123");
    expect(next?.channels?.signal?.dmPolicy).toBe("pairing");
    expect(next?.channels?.signal?.allowFrom).toBeUndefined();
    expect(next?.channels?.signal?.accounts?.default).toMatchObject({
      dmPolicy: "disabled",
      allowFrom: ["+15555550125"],
    });
    expect(next?.channels?.signal?.accounts?.default).not.toHaveProperty("account");
  });

  it("repairs a duplicate explicit managed port before runtime resolution", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            accounts: {
              personal: {
                account: "+15555550123",
                transport: { kind: "managed-native", httpPort: 8181 },
              },
              work: {
                account: "+15555550124",
                transport: { kind: "managed-native", httpPort: 8181 },
              },
            },
          },
        },
      },
      accountId: "work",
      input: { httpPort: "8282" },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8282,
    });
  });

  it("realigns an existing managed connection URL after a partial bind update", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            accounts: {
              work: {
                account: "+15555550124",
                transport: {
                  kind: "managed-native",
                  url: "http://127.0.0.1:8181",
                  httpHost: "127.0.0.1",
                  httpPort: 8181,
                },
              },
            },
          },
        },
      },
      accountId: "work",
      input: { httpHost: "127.0.0.2", httpPort: "8282" },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toMatchObject({
      kind: "managed-native",
      url: "http://127.0.0.2:8282",
      httpHost: "127.0.0.2",
      httpPort: 8282,
    });
  });

  it("uses the setup transport allocator for a second managed account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
          accounts: { work: { account: "+15555550124" } },
        },
      },
    };

    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg,
      accountId: "work",
      input: { signalNumber: "+15555550124" },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "managed-native",
      httpHost: "127.0.0.1",
      httpPort: 8081,
    });
  });

  it("preserves managed transport options during a partial setup update", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          accounts: {
            work: {
              account: "+15555550124",
              transport: {
                kind: "managed-native",
                cliPath: "/opt/old-signal-cli",
                configPath: "/var/lib/signal-work",
                httpHost: "127.0.0.2",
                httpPort: 8181,
                receiveMode: "manual",
                ignoreStories: true,
              },
            },
          },
        },
      },
    };

    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg,
      accountId: "work",
      input: { cliPath: "/opt/new-signal-cli" },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "managed-native",
      cliPath: "/opt/new-signal-cli",
      configPath: "/var/lib/signal-work",
      httpHost: "127.0.0.2",
      httpPort: 8181,
      receiveMode: "manual",
      ignoreStories: true,
    });
  });

  it("makes a new default transport update authoritative over accounts.default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          accounts: {
            default: {
              account: "+15555550124",
              transport: { kind: "external-native", url: "http://old-signal:8080" },
            },
          },
        },
      },
    };

    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg,
      accountId: "default",
      input: { cliPath: "/opt/new-signal-cli" },
    });

    expect(next?.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      cliPath: "/opt/new-signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });
    expect(next?.channels?.signal?.accounts?.default).not.toHaveProperty("transport");
  });

  it("keeps the canonical root transport during a default account-only update", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          transport: { kind: "external-native", url: "http://canonical-signal:8080" },
          accounts: {
            default: {
              account: "+15555550124",
              transport: { kind: "container", url: "http://stale-container:8080" },
            },
          },
        },
      },
    };

    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg,
      accountId: "default",
      input: { signalNumber: "+15555550125" },
    });

    expect(next?.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://canonical-signal:8080",
    });
    expect(next?.channels?.signal?.accounts?.default).toBeUndefined();
  });

  it("stores an explicitly selected container endpoint", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {},
      accountId: "work",
      input: {
        signalNumber: "+15555550124",
        httpUrl: "http://signal-container:8080/",
        signalTransport: "container",
      },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://signal-container:8080",
    });
  });

  it("keeps bare HTTP URLs on the historical external-native transport", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {},
      accountId: "work",
      input: {
        signalNumber: "+15555550124",
        httpUrl: "signal-native:8080",
      },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "external-native",
      url: "http://signal-native:8080",
    });
  });

  it("preserves an existing container kind when only its URL changes", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            accounts: {
              work: {
                transport: { kind: "container", url: "http://old-container:8080" },
              },
            },
          },
        },
      },
      accountId: "work",
      input: { httpUrl: "http://new-container:8080/" },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://new-container:8080",
    });
  });

  it("preserves a nested default container kind while canonicalizing a URL-only edit", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            accounts: {
              Default: {
                account: "+15555550123",
                transport: { kind: "container", url: "http://old-container:8080" },
              },
            },
          },
        },
      },
      accountId: "default",
      input: { httpUrl: "http://new-container:8080/" },
    });

    expect(next?.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://new-container:8080",
    });
    expect(next?.channels?.signal?.accounts?.Default).not.toHaveProperty("transport");
  });

  it.each(["abc", "++12345", "+1+2345", "+1234", "+1234567890123456", "   ", ""])(
    "rejects invalid Signal account number %s",
    (signalNumber) => {
      expect(
        signalSetupAdapter.validateInput?.({
          cfg: {},
          accountId: "work",
          input: { signalNumber },
        }),
      ).toBe("Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)");
    },
  );

  it.each(["0", "abc", "65536"])("rejects invalid managed HTTP port %s", (httpPort) => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {},
        accountId: "work",
        input: { httpPort },
      }),
    ).toBe("Signal --http-port must be an integer between 1 and 65535.");
  });

  it.each(["bad host", "host/path", "[::1", "localhost:8181", "bad:host"])(
    "rejects invalid managed HTTP host %s",
    (httpHost) => {
      expect(
        signalSetupAdapter.validateInput?.({
          cfg: {},
          accountId: "work",
          input: { httpHost },
        }),
      ).toBe("Signal --http-host must be a hostname or IP address.");
    },
  );

  it("rejects a transport kind without an HTTP URL", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {},
        accountId: "work",
        input: { signalTransport: "container" },
      }),
    ).toBe("Signal --signal-transport requires --http-url.");
  });

  it("rejects a fresh container transport without a Signal account", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {},
        accountId: "work",
        input: {
          httpUrl: "http://signal-container:8080",
          signalTransport: "container",
        },
      }),
    ).toBe("Signal container transport requires --signal-number or an existing account.");
  });

  it("rejects an invalid replacement without overwriting an existing container account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "container", url: "http://signal-container:8080" },
        },
      },
    };
    const input = {
      signalNumber: "abc",
      signalTransport: "container" as const,
      httpUrl: "http://signal-container:8080",
    };

    expect(signalSetupAdapter.validateInput?.({ cfg, accountId: "default", input })).toBe(
      "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)",
    );
    expect(
      signalSetupAdapter.applyAccountConfig?.({ cfg, accountId: "default", input })?.channels
        ?.signal?.account,
    ).toBe("+15555550123");
  });

  it("allows a container transport to reuse the configured Signal account", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {
          channels: {
            signal: {
              accounts: { work: { account: "+15555550124" } },
            },
          },
        },
        accountId: "work",
        input: {
          httpUrl: "http://signal-container:8080",
          signalTransport: "container",
        },
      }),
    ).toBeNull();
  });

  it("sends setup to doctor instead of shadowing an account key that needs canonicalization", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {
          channels: {
            signal: {
              accounts: { "Work Phone": { account: "+15555550123", name: "Work" } },
            },
          },
        },
        accountId: "work-phone",
        input: { signalTransport: "external-native", httpUrl: "http://127.0.0.1:9299" },
      }),
    ).toBe(
      'Signal account "work-phone" is stored under channels.signal.accounts."Work Phone"; run openclaw doctor --fix to move it to its normalized key, then rerun setup.',
    );
  });

  it("tells the operator to resolve colliding keys instead of promising a doctor move", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {
          channels: {
            signal: {
              accounts: {
                "Work Phone": { account: "+15555550123" },
                "work.phone": { account: "+15555550124" },
              },
            },
          },
        },
        accountId: "work-phone",
        input: { signalTransport: "external-native", httpUrl: "http://127.0.0.1:9299" },
      }),
    ).toBe(
      'Signal account "work-phone" is stored under channels.signal.accounts "Work Phone", "work.phone", which doctor cannot choose between. Rename them so one key is "work-phone", then rerun setup.',
    );
  });

  it("still configures the default account beside a default key that needs canonicalization", async () => {
    const cfg = defaultAliasConfig();
    const input = {
      signalTransport: "container" as const,
      httpUrl: "http://signal-container:9090",
    };

    const prepared = await signalSetupAdapter.prepareAccountConfigInput?.({
      cfg,
      accountId: "default",
      input,
      runtime: {} as never,
    });
    expect(
      signalSetupAdapter.validateInput?.({ cfg, accountId: "default", input: prepared ?? input }),
    ).toBeNull();
    const reloaded = reload(
      signalSetupAdapter.applyAccountConfig?.({ cfg, accountId: "default", input }),
    );

    expect(Object.keys(reloaded.channels?.signal?.accounts ?? {})).toEqual(["Default."]);
    expect(reloaded.channels?.signal?.account).toBe("+15555550100");
    expect(reloaded.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://signal-container:9090",
    });
  });

  it("sends a default display name to doctor and writes one entry after the repair", () => {
    const cfg = defaultAliasConfig();
    const input = {
      name: "Renamed",
      signalTransport: "container" as const,
      httpUrl: "http://signal-container:9090",
    };
    const doctorPointer =
      'Signal account "default" is stored under channels.signal.accounts."Default."; run openclaw doctor --fix to move it to its normalized key, then rerun setup.';

    expect(signalSetupAdapter.validateInput?.({ cfg, accountId: "default", input })).toBe(
      doctorPointer,
    );
    // Guided naming reaches applyAccountName directly (src/commands/channels/add-mutators.ts:21),
    // so the same precondition has to hold at that writer.
    expect(() =>
      signalSetupAdapter.applyAccountName?.({ cfg, accountId: "default", name: "Renamed" }),
    ).toThrow(doctorPointer);

    const repaired = reload(normalizeCompatibilityConfig({ cfg }).config);
    expect(signalSetupAdapter.validateInput?.({ cfg: repaired, accountId: "default", input })).toBe(
      null,
    );
    const reloaded = reload(
      signalSetupAdapter.applyAccountConfig?.({ cfg: repaired, accountId: "default", input }),
    );

    expect(reloaded.channels?.signal?.accounts).toEqual({
      default: { name: "Renamed", textChunkLimit: 123 },
    });
    expect(reloaded.channels?.signal?.account).toBe("+15555550100");
    expect(reloaded.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://signal-container:9090",
    });
  });

  it("updates the repaired account entry without creating a second one", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          accounts: {
            "work-phone": {
              account: "+15555550123",
              name: "Work",
              transport: { kind: "external-native", url: "http://127.0.0.1:9199" },
            },
          },
        },
      },
    };
    const input = await signalSetupAdapter.prepareAccountConfigInput?.({
      cfg,
      accountId: "work-phone",
      input: { signalTransport: "external-native", httpUrl: "http://127.0.0.1:9299" },
      runtime: {} as never,
    });
    if (!input) {
      throw new Error("expected prepared Signal setup input");
    }

    expect(signalSetupAdapter.validateInput?.({ cfg, accountId: "work-phone", input })).toBeNull();
    const accounts = signalSetupAdapter.applyAccountConfig?.({
      cfg,
      accountId: "work-phone",
      input,
    })?.channels?.signal?.accounts;
    expect(Object.keys(accounts ?? {})).toEqual(["work-phone"]);
    expect(accounts?.["work-phone"]).toMatchObject({
      account: "+15555550123",
      name: "Work",
      transport: { kind: "external-native", url: "http://127.0.0.1:9299" },
    });
  });

  it("refuses a named add that would migrate a root name beside a default key needing repair", () => {
    const input = {
      signalTransport: "container" as const,
      httpUrl: "http://signal-container:9090",
    };

    // Adding a named account moves an existing root display name into accounts.default
    // (src/channels/plugins/setup-helpers.ts:65-86), which would shadow the authored key.
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: defaultAliasConfig({ name: "Primary" }),
        accountId: "work",
        input,
      }),
    ).toBe(
      'Signal account "default" is stored under channels.signal.accounts."Default."; run openclaw doctor --fix to move it to its normalized key, then rerun setup.',
    );

    // With no promotable root key the promotion writes nothing, so the add lands on `work` alone.
    const control: OpenClawConfig = {
      channels: {
        signal: {
          transport: { kind: "container", url: "http://signal-container:8080" },
          accounts: { "Default.": { name: "Existing", textChunkLimit: 123 } },
        },
      },
    };
    const authored = structuredClone(control);
    const nativeInput = {
      signalTransport: "external-native" as const,
      httpUrl: "http://127.0.0.1:9299",
    };
    expect(
      signalSetupAdapter.validateInput?.({ cfg: control, accountId: "work", input: nativeInput }),
    ).toBeNull();
    const reloaded = reload(addNamedAccount(control, "work", nativeInput));
    expect(Object.keys(reloaded.channels?.signal?.accounts ?? {})).toEqual(["Default.", "work"]);
    expect(reloaded.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://signal-container:8080",
    });
    expect(reloaded.channels?.signal?.accounts?.["Default."]).toEqual(
      authored.channels?.signal?.accounts?.["Default."],
    );
  });

  it("sends a named add to doctor when promotion would write the default alias", async () => {
    const cfg = defaultAliasConfig();
    const doctorPointer =
      'Signal account "default" is stored under channels.signal.accounts."Default."; run openclaw doctor --fix to move it to its normalized key, then rerun setup.';

    // The promotion moves the root number into the first map key normalizing to "default", which
    // is the unrepaired alias itself (src/channels/plugins/setup-helpers.ts:357-358, :390-403),
    // and nothing restores it from there, so the root would lose its number for good.
    expect(
      signalSetupAdapter.validateInput?.({
        cfg,
        accountId: "work",
        input: { signalTransport: "external-native", httpUrl: "http://127.0.0.1:9299" },
      }),
    ).toBe(doctorPointer);

    detectSignalTransportMock.mockRejectedValue(new Error("unreachable"));
    const bareInput = { httpUrl: "http://127.0.0.1:9299" };
    const prepared = await signalSetupAdapter.prepareAccountConfigInput?.({
      cfg,
      accountId: "work",
      input: bareInput,
      runtime: {} as never,
    });

    expect(detectSignalTransportMock).not.toHaveBeenCalled();
    expect(prepared).toBe(bareInput);
    expect(
      signalSetupAdapter.validateInput?.({ cfg, accountId: "work", input: prepared ?? bareInput }),
    ).toBe(doctorPointer);
  });

  it("sends a named add to doctor when promotion would write a named alias", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550100",
          accounts: {
            "Work Phone": {
              account: "+15555550123",
              transport: { kind: "external-native", url: "http://127.0.0.1:9101" },
            },
          },
        },
      },
    };

    // With exactly one map key the promotion targets it however it is spelled
    // (src/channels/plugins/setup-helpers.ts:357-358), so the root number would be dropped into
    // the unselected alias instead of reaching accounts.default.
    expect(
      signalSetupAdapter.validateInput?.({
        cfg,
        accountId: "work",
        input: { signalTransport: "external-native", httpUrl: "http://127.0.0.1:9299" },
      }),
    ).toBe(
      'Signal account "work-phone" is stored under channels.signal.accounts."Work Phone"; run openclaw doctor --fix to move it to its normalized key, then rerun setup.',
    );
  });

  it("adds a named account after the default key repair and keeps the root number on the root", () => {
    const repaired = reload(normalizeCompatibilityConfig({ cfg: defaultAliasConfig() }).config);
    const input = {
      signalTransport: "container" as const,
      httpUrl: "http://signal-container:9090",
    };

    expect(signalSetupAdapter.validateInput?.({ cfg: repaired, accountId: "work", input })).toBe(
      null,
    );
    const reloaded = reload(addNamedAccount(repaired, "work", input));

    // The promotion now lands on the canonical key, so the adapter's restore step
    // (restorePromotedSignalDefaultAccount) can move the number back beside the root transport.
    expect(Object.keys(reloaded.channels?.signal?.accounts ?? {})).toEqual(["default", "work"]);
    expect(reloaded.channels?.signal?.account).toBe("+15555550100");
    expect(reloaded.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://signal-container:8080",
    });
    expect(reloaded.channels?.signal?.accounts?.default).toEqual({
      name: "Existing",
      textChunkLimit: 123,
    });
    expect(reloaded.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://signal-container:9090",
    });
  });

  it("adds a named account when promotion lands on the exact key listed after its stranded twin", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550100",
          accounts: { "Default.": { name: "Alias" }, default: { name: "Canon" } },
        },
      },
    };
    const authored = structuredClone(cfg);

    // The promotion resolves its key with the lookup Signal declares (accountEntryLookup in
    // setup-core.ts, applied by resolveExistingAccountKey in src/channels/plugins/setup-helpers.ts),
    // so the exact key wins however late it is listed and the root number lands where every reader
    // looks. Before this change the writer took the first key normalizing to "default", the
    // stranded alias, and this add was refused with a rename pointer. Doctor's collision warning
    // still reports the pair.
    expect(
      signalSetupAdapter.validateInput?.({ cfg, accountId: "work", input: externalNativeInput }),
    ).toBeNull();
    const reloaded = reload(addNamedAccount(cfg, "work", externalNativeInput));
    const accounts = reloaded.channels?.signal?.accounts;

    expect(Object.keys(accounts ?? {})).toEqual(["Default.", "default", "work"]);
    expect(accounts?.default).toEqual({ name: "Canon", account: "+15555550100" });
    expect(accounts?.["Default."]).toEqual(authored.channels?.signal?.accounts?.["Default."]);
    expect(reloaded.channels?.signal?.account).toBeUndefined();
    expect(resolveSignalAccount({ cfg: reloaded, accountId: "default" }).config.account).toBe(
      "+15555550100",
    );
  });

  it("adds a named account when promotion lands on the selected key beside its stranded twin", () => {
    const cfg = defaultAliasConfig({
      accounts: { default: { name: "Canon" }, "Default.": { name: "Alias" } },
    });
    const authored = structuredClone(cfg);
    const input = externalNativeInput;

    // Listed first, the exact key is the promotion's target, so the root number lands where every
    // reader looks and the adapter's restore step can move it back beside the root transport.
    expect(signalSetupAdapter.validateInput?.({ cfg, accountId: "work", input })).toBeNull();
    const reloaded = reload(addNamedAccount(cfg, "work", input));
    const accounts = reloaded.channels?.signal?.accounts;

    expect(Object.keys(accounts ?? {})).toEqual(["default", "Default.", "work"]);
    expect(reloaded.channels?.signal?.account).toBe("+15555550100");
    expect(accounts?.default).toEqual({ name: "Canon" });
    expect(accounts?.["Default."]).toEqual(authored.channels?.signal?.accounts?.["Default."]);
    expect(resolveSignalAccount({ cfg: reloaded, accountId: "default" }).config.account).toBe(
      "+15555550100",
    );
  });

  it("adds a named account beside a stranded named key when promotion has nothing to move", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          accounts: {
            "work-phone": {
              account: "+15555550123",
              transport: { kind: "external-native", url: "http://127.0.0.1:9101" },
            },
            "Work Phone": { name: "Old" },
          },
        },
      },
    };
    const authored = structuredClone(cfg);
    const input = externalNativeInput;

    // With no promotable root key the promotion returns the config unchanged, so nothing reaches
    // the stranded key; doctor's collision warning owns that pair, not setup.
    expect(signalSetupAdapter.validateInput?.({ cfg, accountId: "other", input })).toBeNull();
    const reloaded = reload(addNamedAccount(cfg, "other", input));
    const accounts = reloaded.channels?.signal?.accounts;

    expect(Object.keys(accounts ?? {})).toEqual(["work-phone", "Work Phone", "other"]);
    expect(accounts?.["work-phone"]).toEqual(authored.channels?.signal?.accounts?.["work-phone"]);
    expect(accounts?.["Work Phone"]).toEqual(authored.channels?.signal?.accounts?.["Work Phone"]);
  });

  it("renames a canonical named account without touching the default alias beside it", () => {
    // Guided naming lands accounts.work alone: the name-only adapter never migrates the root name
    // (src/channels/plugins/setup-helpers.ts:139-147), so the unrepaired default key is not written.
    const cfg = defaultAliasConfig({
      name: "Root",
      accounts: {
        "Default.": { name: "Alias" },
        work: {
          account: "+15555550124",
          transport: { kind: "external-native", url: "http://127.0.0.1:9290" },
          name: "Old",
        },
      },
    });
    const authored = structuredClone(cfg);

    const next = signalSetupAdapter.applyAccountName?.({ cfg, accountId: "work", name: "New" });

    expect(Object.keys(next?.channels?.signal?.accounts ?? {})).toEqual(["Default.", "work"]);
    expect(next?.channels?.signal?.accounts?.work?.name).toBe("New");
    expect(next?.channels?.signal?.name).toBe("Root");
    expect(next?.channels?.signal?.accounts?.["Default."]).toEqual(
      authored.channels?.signal?.accounts?.["Default."],
    );
    expect(cfg).toEqual(authored);
  });

  it("keeps a blank guided name a no-op beside a named key that needs canonicalization", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: { accounts: { "Work Phone": { account: "+15555550123", name: "Work" } } },
      },
    };

    // A blank name writes nothing (src/channels/plugins/setup-helpers.ts:41-44), so there is no
    // account-map target to check and no doctor pointer to raise.
    expect(
      signalSetupAdapter.applyAccountName?.({ cfg, accountId: "work-phone", name: "  " }),
    ).toBe(cfg);
  });

  it("sends a bare URL to doctor before transport discovery can fail first", async () => {
    detectSignalTransportMock.mockRejectedValue(new Error("unreachable"));
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          accounts: {
            "Work Phone": {
              account: "+15555550123",
              transport: { kind: "external-native", url: "http://127.0.0.1:9101" },
            },
          },
        },
      },
    };
    const input = { httpUrl: "http://127.0.0.1:9299" };

    // prepareAccountConfigInput runs ahead of validateInput
    // (src/channels/plugins/account-config-mutation.ts:94-110), and with no selectable transport to
    // fall back on, discovery's endpoint error would reach the operator instead of the pointer.
    const prepared = await signalSetupAdapter.prepareAccountConfigInput?.({
      cfg,
      accountId: "work-phone",
      input,
      runtime: {} as never,
    });

    expect(detectSignalTransportMock).not.toHaveBeenCalled();
    expect(prepared).toBe(input);
    expect(
      signalSetupAdapter.validateInput?.({
        cfg,
        accountId: "work-phone",
        input: prepared ?? input,
      }),
    ).toBe(
      'Signal account "work-phone" is stored under channels.signal.accounts."Work Phone"; run openclaw doctor --fix to move it to its normalized key, then rerun setup.',
    );
  });

  it("allows a named container transport to inherit the root Signal account", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {
          channels: {
            signal: { account: "+15555550123" },
          },
        },
        accountId: "work",
        input: {
          httpUrl: "http://signal-container:8080",
          signalTransport: "container",
        },
      }),
    ).toBeNull();
  });

  it("does not materialize a CLI path for an external transport", async () => {
    const input = createSignalCliPathTextInput(async () => false);
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550124",
          transport: { kind: "container", url: "http://signal:8080" },
        },
      },
    };

    expect(
      await input.currentValue?.({ cfg, accountId: "default", credentialValues: {} }),
    ).toBeUndefined();
    const wizardInput = signalSetupWizard.textInputs?.find((entry) => entry.inputKey === "cliPath");
    expect(
      await wizardInput?.shouldPrompt?.({
        cfg,
        accountId: "default",
        credentialValues: {},
      }),
    ).toBe(false);
  });

  it("reports an external transport as configured without checking signal-cli", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550124",
          transport: { kind: "external-native", url: "http://signal:8080" },
        },
      },
    };
    const configured = await signalSetupWizard.status.resolveConfigured({
      cfg,
      accountId: "default",
    });
    const params = { cfg, accountId: "default", configured };

    await expect(signalSetupWizard.status.resolveStatusLines?.(params)).resolves.toEqual([
      "Signal: configured",
    ]);
    await expect(signalSetupWizard.status.resolveSelectionHint?.(params)).resolves.toBe(
      "configured",
    );
    await expect(signalSetupWizard.status.resolveQuickstartScore?.(params)).resolves.toBe(1);
  });
});
