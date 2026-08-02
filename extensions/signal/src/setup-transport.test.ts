// Signal tests cover the setup-facing transport contract.
import { describe, expect, it, vi } from "vitest";
import { resolveSignalAccount } from "./accounts.js";
import {
  detectSignalTransport,
  prepareSignalManagedNativeTransport,
  probeSignalTransport,
  writeSignalAccountTransport,
} from "./setup-transport.js";

describe("detectSignalTransport", () => {
  it("prefers native deterministically when both endpoints are healthy", async () => {
    const transport = await detectSignalTransport({
      url: "http://signal:8080",
      probeNative: vi.fn().mockResolvedValue({ ok: true }),
      probeContainer: vi.fn().mockResolvedValue({ ok: true }),
    });

    expect(transport).toEqual({ kind: "external-native", url: "http://signal:8080" });
  });

  it("selects container only when its endpoint is healthy", async () => {
    const probeContainer = vi.fn().mockResolvedValue({ ok: true });
    const transport = await detectSignalTransport({
      url: "http://signal:8080/",
      account: "+15555550123",
      probeNative: vi.fn().mockResolvedValue({ ok: false }),
      probeContainer,
    });

    expect(transport).toEqual({ kind: "container", url: "http://signal:8080" });
    expect(probeContainer).toHaveBeenCalledWith("http://signal:8080", 10_000, "+15555550123");
  });

  it("rejects an endpoint that matches neither transport", async () => {
    await expect(
      detectSignalTransport({
        url: "http://signal:8080",
        probeNative: vi.fn().mockResolvedValue({ ok: false }),
        probeContainer: vi.fn().mockResolvedValue({ ok: false }),
      }),
    ).rejects.toThrow("Signal transport not reachable at http://signal:8080");
  });
});

describe("prepareSignalManagedNativeTransport", () => {
  it("normalizes the default account id before preserving its managed transport", () => {
    const cfg = {
      channels: {
        signal: {
          transport: {
            kind: "managed-native",
            url: "https://127.0.0.1:9443",
            cliPath: "/opt/signal-cli",
            configPath: "/var/lib/signal-cli",
            httpHost: "127.0.0.2",
            httpPort: 8181,
            startupTimeoutMs: 45_000,
          },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: " Default " }),
    ).toEqual({
      kind: "managed-native",
      url: "https://127.0.0.1:9443",
      cliPath: "/opt/signal-cli",
      configPath: "/var/lib/signal-cli",
      httpHost: "127.0.0.2",
      httpPort: 8181,
      startupTimeoutMs: 45_000,
    });
  });

  it("allocates distinct ports for managed native accounts", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
          accounts: { work: { account: "+15555550124" } },
        },
      },
    } as const;

    expect(prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "work" })).toEqual({
      kind: "managed-native",
      httpHost: "127.0.0.1",
      httpPort: 8081,
    });
  });

  it("rejects an explicitly requested port owned by another account", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
          accounts: { work: { account: "+15555550124" } },
        },
      },
    } as const;

    expect(() =>
      prepareSignalManagedNativeTransport({
        cfg: cfg as never,
        accountId: "work",
        overrides: { httpPort: 8080 },
      }),
    ).toThrow("Signal managed native port 8080 is already reserved");
  });

  it("preserves an existing implicit port when adding a lexically earlier account", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            work: { account: "+15555550124", transport: { kind: "managed-native" } },
          },
        },
      },
    } as const;

    expect(resolveSignalAccount({ cfg: cfg as never, accountId: "work" }).transport).toMatchObject({
      httpPort: 8080,
    });
    const transport = prepareSignalManagedNativeTransport({
      cfg: cfg as never,
      accountId: "personal",
    });
    const next = writeSignalAccountTransport({
      cfg: cfg as never,
      accountId: "personal",
      transport,
    });

    expect(transport.httpPort).toBe(8081);
    expect(resolveSignalAccount({ cfg: next, accountId: "work" }).transport).toMatchObject({
      httpPort: 8080,
    });
  });

  it("keeps sibling implicit allocation stable while updating an existing target", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            a: {
              account: "+15555550123",
              transport: { kind: "managed-native", httpPort: 8080 },
            },
            b: { account: "+15555550124", transport: { kind: "managed-native" } },
          },
        },
      },
    } as const;

    const transport = prepareSignalManagedNativeTransport({
      cfg: cfg as never,
      accountId: "a",
      overrides: { cliPath: "/opt/signal-cli" },
    });
    const next = writeSignalAccountTransport({
      cfg: cfg as never,
      accountId: "a",
      transport,
    });

    expect(transport.httpPort).toBe(8080);
    expect(resolveSignalAccount({ cfg: next, accountId: "b" }).transport).toMatchObject({
      httpPort: 8081,
    });
  });

  it("preserves managed options behind a case-preserving account key", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            Ops: {
              account: "+15555550124",
              transport: {
                kind: "managed-native",
                cliPath: "/opt/signal-cli",
                httpPort: 8181,
              },
            },
          },
        },
      },
    } as const;

    expect(prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "ops" })).toEqual({
      kind: "managed-native",
      cliPath: "/opt/signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8181,
    });
  });

  it("reserves a configured default account when setup will re-enable the channel", () => {
    const cfg = {
      channels: {
        signal: {
          enabled: false,
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
          accounts: { work: { account: "+15555550124" } },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "work" }).httpPort,
    ).toBe(8081);
  });

  it("reserves ports owned by disabled named accounts", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            dormant: {
              enabled: false,
              account: "+15555550123",
              transport: { kind: "managed-native", httpPort: 8080 },
            },
            work: { account: "+15555550124" },
          },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "work" }).httpPort,
    ).toBe(8081);
  });

  it("preserves a selected account's collision-free managed port and options", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
          accounts: {
            work: {
              account: "+15555550124",
              transport: {
                kind: "managed-native",
                httpHost: "0.0.0.0",
                httpPort: 19089,
                cliPath: "/opt/signal-cli",
              },
            },
          },
        },
      },
    } as const;

    expect(prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "work" })).toEqual({
      kind: "managed-native",
      httpHost: "0.0.0.0",
      httpPort: 19089,
      cliPath: "/opt/signal-cli",
    });
  });

  it("keeps an aligned managed connection URL on the allocated bind port", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
          accounts: {
            work: {
              account: "+15555550124",
              transport: {
                kind: "managed-native",
                url: "http://127.0.0.1:8080",
                httpHost: "0.0.0.0",
              },
            },
          },
        },
      },
    } as const;

    expect(prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "work" })).toEqual({
      kind: "managed-native",
      url: "http://127.0.0.1:8081",
      httpHost: "0.0.0.0",
      httpPort: 8081,
    });
  });

  it("keeps an existing managed connection URL aligned with bind overrides", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: {
            kind: "managed-native",
            url: "http://127.0.0.2:8080",
            httpHost: "127.0.0.2",
            httpPort: 8080,
          },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({
        cfg: cfg as never,
        accountId: "default",
        overrides: { httpHost: "127.0.0.3", httpPort: 8181 },
      }),
    ).toEqual({
      kind: "managed-native",
      url: "http://127.0.0.3:8181",
      httpHost: "127.0.0.3",
      httpPort: 8181,
    });
  });

  it("keeps an exact LAN connection URL aligned with bind port changes", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: {
            kind: "managed-native",
            url: "http://192.168.1.2:8181",
            httpHost: "192.168.1.2",
            httpPort: 8181,
          },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({
        cfg: cfg as never,
        accountId: "default",
        overrides: { httpPort: 8282 },
      }),
    ).toEqual({
      kind: "managed-native",
      url: "http://192.168.1.2:8282",
      httpHost: "192.168.1.2",
      httpPort: 8282,
    });
  });

  it("reserves a local HTTPS proxy endpoint independently from the daemon bind", () => {
    const cfg = {
      channels: {
        signal: {
          transport: {
            kind: "managed-native",
            url: "https://127.0.0.1:8080",
          },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "default" }),
    ).toEqual({
      kind: "managed-native",
      url: "https://127.0.0.1:8080",
      httpHost: "127.0.0.1",
      httpPort: 8081,
    });
  });

  it("uses IPv6 loopback when an aligned endpoint moves to the IPv6 wildcard bind", () => {
    const cfg = {
      channels: {
        signal: {
          transport: {
            kind: "managed-native",
            url: "http://127.0.0.1:8080",
            httpHost: "127.0.0.1",
            httpPort: 8080,
          },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({
        cfg: cfg as never,
        accountId: "default",
        overrides: { httpHost: "::" },
      }),
    ).toEqual({
      kind: "managed-native",
      url: "http://[::1]:8080",
      httpHost: "::",
      httpPort: 8080,
    });
  });

  it("reserves ports used by enabled local external transports", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            external: {
              account: "+15555550123",
              transport: { kind: "external-native", url: "http://localhost:8080" },
            },
            work: { account: "+15555550124" },
          },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "work" }).httpPort,
    ).toBe(8081);
  });

  it.each(["http://localhost.:8080", "http://[::ffff:127.0.0.1]:8080"])(
    "reserves port 8080 for loopback alias %s",
    (url) => {
      const cfg = {
        channels: {
          signal: {
            accounts: {
              external: {
                account: "+15555550123",
                transport: { kind: "external-native", url },
              },
              work: { account: "+15555550124" },
            },
          },
        },
      } as const;

      expect(
        prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "work" }).httpPort,
      ).toBe(8081);
    },
  );

  it("reserves managed bind and local connection endpoint ports", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            proxy: {
              account: "+15555550123",
              transport: {
                kind: "managed-native",
                url: "http://localhost:8080",
                httpPort: 8181,
              },
            },
            work: { account: "+15555550124" },
          },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({ cfg: cfg as never, accountId: "work" }).httpPort,
    ).toBe(8081);
  });

  it.each([0, Number.NaN, 65_536])("rejects invalid preferred port %s", (httpPort) => {
    expect(() =>
      prepareSignalManagedNativeTransport({
        cfg: {},
        accountId: "work",
        overrides: { httpPort },
      }),
    ).toThrow("Signal managed native port must be an integer between 1 and 65535.");
  });
});

describe("probeSignalTransport", () => {
  it("probes only the configured concrete transport", async () => {
    const probeNative = vi.fn().mockResolvedValue({ ok: true });
    const probeContainer = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      probeSignalTransport({
        cfg: {},
        accountId: "default",
        transport: { kind: "container", url: "http://signal:8080" },
        account: "+15555550123",
        probeNative,
        probeContainer,
      }),
    ).resolves.toEqual({ ok: true });
    expect(probeNative).not.toHaveBeenCalled();
    expect(probeContainer).toHaveBeenCalledWith("http://signal:8080", 10_000, "+15555550123");
  });

  it("probes the allocated port for an implicit managed account transport", async () => {
    const probeNative = vi.fn().mockResolvedValue({ ok: true });
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
          accounts: { work: { account: "+15555550124" } },
        },
      },
    } as const;

    await expect(
      probeSignalTransport({
        cfg: cfg as never,
        accountId: "work",
        transport: { kind: "managed-native" },
        probeNative,
      }),
    ).resolves.toEqual({ ok: true });
    expect(probeNative).toHaveBeenCalledWith("http://127.0.0.1:8081", 10_000);
  });
});

describe("writeSignalAccountTransport", () => {
  it("ignores the unconfigured implicit default account during endpoint collision checks", () => {
    const next = writeSignalAccountTransport({
      cfg: {},
      accountId: "work",
      transport: { kind: "external-native", url: "http://localhost:8080" },
    });

    expect(next.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "external-native",
      url: "http://localhost:8080",
    });
  });

  it("rejects explicit non-HTTP endpoint schemes", () => {
    expect(() =>
      writeSignalAccountTransport({
        cfg: {},
        accountId: "default",
        transport: { kind: "external-native", url: "ftp://signal.example" },
      }),
    ).toThrow("Signal transport URL unsupported protocol: ftp:");
  });

  it.each(["http:/localhost:8080", "http:localhost:8080", "http:///localhost:8080"])(
    "rejects malformed HTTP endpoint %s",
    (url) => {
      expect(() =>
        writeSignalAccountTransport({
          cfg: {},
          accountId: "default",
          transport: { kind: "external-native", url },
        }),
      ).toThrow("Signal transport URL has a malformed HTTP scheme");
    },
  );

  it("rejects a local external endpoint on an enabled sibling managed bind", () => {
    expect(() =>
      writeSignalAccountTransport({
        cfg: {
          channels: {
            signal: {
              enabled: false,
              account: "+15555550123",
              transport: { kind: "managed-native", httpPort: 8181 },
            },
          },
        },
        accountId: "work",
        transport: { kind: "external-native", url: "http://localhost:8181" },
      }),
    ).toThrow(
      'Signal external-native account "work" uses local port 8181, which conflicts with managed native account "default".',
    );
  });

  it("rejects a local external endpoint on a sibling's implicit managed bind", () => {
    expect(() =>
      writeSignalAccountTransport({
        cfg: {
          channels: {
            signal: {
              accounts: {
                work: {
                  account: "+15555550123",
                  transport: { kind: "managed-native" },
                },
              },
            },
          },
        },
        accountId: "personal",
        transport: { kind: "external-native", url: "http://localhost:8080" },
      }),
    ).toThrow(
      'Signal external-native account "personal" uses local port 8080, which conflicts with managed native account "work".',
    );
  });

  it("allows a local external endpoint on a disabled sibling managed bind", () => {
    const next = writeSignalAccountTransport({
      cfg: {
        channels: {
          signal: {
            account: "+15555550124",
            accounts: {
              dormant: {
                enabled: false,
                account: "+15555550123",
                transport: { kind: "managed-native", httpPort: 8181 },
              },
            },
          },
        },
      },
      accountId: "work",
      transport: { kind: "container", url: "http://localhost:8181" },
    });

    expect(next.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://localhost:8181",
    });
  });

  it("writes the implicit default account without changing named accounts", () => {
    const next = writeSignalAccountTransport({
      cfg: {
        channels: {
          signal: {
            dmPolicy: "allowlist",
            apiMode: "native",
            httpUrl: "http://legacy-native:8080",
            autoStart: false,
            accounts: { work: { account: "+15555550123" } },
          },
        },
      } as never,
      accountId: "default",
      transport: { kind: "external-native", url: "http://native:8080" },
    });

    expect(next.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://native:8080",
    });
    expect(next.channels?.signal?.accounts?.work).toEqual({ account: "+15555550123" });
    expect(next.channels?.signal?.dmPolicy).toBe("allowlist");
    expect(next.channels?.signal).not.toHaveProperty("apiMode");
    expect(next.channels?.signal).not.toHaveProperty("httpUrl");
    expect(next.channels?.signal).not.toHaveProperty("autoStart");
  });

  it("makes the canonical root authoritative over a nested default transport", () => {
    const next = writeSignalAccountTransport({
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                account: "+15555550123",
                transport: { kind: "managed-native", httpPort: 8181 },
              },
            },
          },
        },
      } as never,
      accountId: "default",
      transport: { kind: "external-native", url: "http://native:8080" },
    });

    expect(next.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://native:8080",
    });
    expect(next.channels?.signal?.accounts?.default).not.toHaveProperty("transport");
  });

  it("writes only the selected named account", () => {
    const next = writeSignalAccountTransport({
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            transport: { kind: "managed-native" },
          },
        },
      },
      accountId: "work",
      transport: { kind: "container", url: "http://container:8080/" },
    });

    expect(next.channels?.signal?.transport).toEqual({ kind: "managed-native" });
    expect(next.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://container:8080",
    });
  });

  it("rejects an enabled container transport without an effective account", () => {
    expect(() =>
      writeSignalAccountTransport({
        cfg: {},
        accountId: "work",
        transport: { kind: "container", url: "http://container:8080" },
      }),
    ).toThrow("Signal container transport requires an account number for an enabled account.");
  });

  it("allows an account-less container transport for a disabled target", () => {
    const next = writeSignalAccountTransport({
      cfg: {
        channels: {
          signal: {
            accounts: { work: { enabled: false } },
          },
        },
      },
      accountId: "work",
      transport: { kind: "container", url: "http://container:8080" },
    });

    expect(next.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://container:8080",
    });
  });

  it("rejects invalid managed native hosts", () => {
    expect(() =>
      writeSignalAccountTransport({
        cfg: {},
        accountId: "default",
        transport: { kind: "managed-native", httpHost: "bad host" },
      }),
    ).toThrow("Signal transport host must be a hostname or IP address");
  });

  it.each(["localhost:8181", "bad:host"])(
    "rejects a managed native host containing a non-IPv6 colon: %s",
    (httpHost) => {
      expect(() =>
        writeSignalAccountTransport({
          cfg: {},
          accountId: "default",
          transport: { kind: "managed-native", httpHost },
        }),
      ).toThrow("Signal transport host must be a hostname or IP address");
    },
  );

  it("rejects a managed bind on a sibling local endpoint", () => {
    expect(() =>
      writeSignalAccountTransport({
        cfg: {
          channels: {
            signal: {
              account: "+15555550123",
              accounts: {
                external: {
                  transport: { kind: "external-native", url: "http://localhost:8181" },
                },
              },
            },
          },
        },
        accountId: "managed",
        transport: { kind: "managed-native", httpPort: 8181 },
      }),
    ).toThrow(
      'Signal managed native account "managed" binds port 8181, which conflicts with account "external" local transport endpoint.',
    );
  });

  it("normalizes a managed native connection URL", () => {
    const next = writeSignalAccountTransport({
      cfg: { channels: { signal: {} } },
      accountId: "default",
      transport: {
        kind: "managed-native",
        url: "127.0.0.1:8181/",
        httpHost: "0.0.0.0",
        httpPort: 8181,
      },
    });

    expect(next.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      url: "http://127.0.0.1:8181",
      httpHost: "0.0.0.0",
      httpPort: 8181,
    });
  });
});
