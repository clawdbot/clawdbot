// Signal tests cover setup adapter integration with account-owned transport policy.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSignalCliPathTextInput, signalSetupAdapter } from "./setup-core.js";
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
