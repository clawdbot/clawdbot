// Signal tests cover accounts plugin behavior.
import { describe, expect, it } from "vitest";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "./accounts.js";

describe("resolveSignalAccount", () => {
  it("resolves an omitted transport to managed native defaults", () => {
    const resolved = resolveSignalAccount({ cfg: { channels: { signal: {} } } as never });

    expect(resolved.transport).toEqual({
      kind: "managed-native",
      baseUrl: "http://127.0.0.1:8080",
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      startupTimeoutMs: 30_000,
    });
  });

  it("uses a managed native connection URL independently from its daemon bind", () => {
    const resolved = resolveSignalAccount({
      cfg: {
        channels: {
          signal: {
            transport: {
              kind: "managed-native",
              url: "http://127.0.0.1:8181",
              httpHost: "0.0.0.0",
              httpPort: 8181,
            },
          },
        },
      } as never,
    });

    expect(resolved.transport).toMatchObject({
      kind: "managed-native",
      baseUrl: "http://127.0.0.1:8181",
      httpHost: "0.0.0.0",
      httpPort: 8181,
    });
  });

  it("formats an IPv6 managed native bind as a valid connection URL", () => {
    const resolved = resolveSignalAccount({
      cfg: {
        channels: {
          signal: {
            transport: {
              kind: "managed-native",
              httpHost: "::1",
              httpPort: 8181,
            },
          },
        },
      } as never,
    });

    expect(resolved.transport).toMatchObject({
      kind: "managed-native",
      baseUrl: "http://[::1]:8181",
      httpHost: "::1",
      httpPort: 8181,
    });
  });

  it("does not reserve a managed transport's own implicit connection endpoint", () => {
    const resolved = resolveSignalAccount({
      cfg: {
        channels: {
          signal: {
            transport: {
              kind: "managed-native",
              url: "http://127.0.0.1:8080",
              httpHost: "0.0.0.0",
            },
          },
        },
      } as never,
    });

    expect(resolved.transport).toMatchObject({
      kind: "managed-native",
      baseUrl: "http://127.0.0.1:8080",
      httpHost: "0.0.0.0",
      httpPort: 8080,
    });
  });

  it("preserves a same-port connection URL on a different specific bind address", () => {
    const resolved = resolveSignalAccount({
      cfg: {
        channels: {
          signal: {
            transport: {
              kind: "managed-native",
              url: "http://127.0.0.1:8080",
              httpHost: "127.0.0.2",
            },
          },
        },
      } as never,
    });

    expect(resolved.transport).toMatchObject({
      kind: "managed-native",
      baseUrl: "http://127.0.0.1:8080",
      httpHost: "127.0.0.2",
      httpPort: 8081,
    });
  });

  it("does not inherit the default account transport into named accounts", () => {
    const cfg = {
      channels: {
        signal: {
          transport: {
            kind: "container",
            url: "http://default-container:8080",
          },
          accounts: {
            work: {
              account: "+15555550123",
            },
          },
        },
      },
    } as never;

    expect(resolveSignalAccount({ cfg }).transport).toEqual({
      kind: "container",
      baseUrl: "http://default-container:8080",
    });
    expect(resolveSignalAccount({ cfg, accountId: "work" }).transport).toMatchObject({
      kind: "managed-native",
      baseUrl: "http://127.0.0.1:8080",
    });
  });

  it("keeps the root transport authoritative over accounts.default", () => {
    const cfg = {
      channels: {
        signal: {
          transport: { kind: "external-native", url: "http://canonical-native:8181" },
          accounts: {
            default: {
              account: "+15555550123",
              transport: { kind: "container", url: "http://stale-container:8080" },
            },
          },
        },
      },
    } as never;

    expect(resolveSignalAccount({ cfg, accountId: "default" }).transport).toEqual({
      kind: "external-native",
      baseUrl: "http://canonical-native:8181",
    });
  });

  it("allocates distinct default ports across managed native accounts", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            personal: { account: "+15555550123", transport: { kind: "managed-native" } },
            work: { account: "+15555550124", transport: { kind: "managed-native" } },
          },
        },
      },
    } as never;

    expect(resolveSignalAccount({ cfg, accountId: "personal" }).transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8080,
    });
    expect(resolveSignalAccount({ cfg, accountId: "work" }).transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8081,
    });
  });

  it("matches case-preserving account keys while allocating implicit ports", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            alpha: {
              account: "+15555550123",
              transport: { kind: "managed-native", httpPort: 8080 },
            },
            Ops: { account: "+15555550124", transport: { kind: "managed-native" } },
          },
        },
      },
    } as never;

    expect(resolveSignalAccount({ cfg, accountId: "Ops" }).transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8081,
    });
  });

  it("rejects duplicate explicit managed native ports", () => {
    const cfg = {
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
    } as never;

    expect(() => resolveSignalAccount({ cfg, accountId: "work" })).toThrow(
      'Signal managed native accounts "work" and "personal" both bind port 8181.',
    );
  });

  it("does not let a disabled account block an active managed port", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            dormant: {
              enabled: false,
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
    } as never;

    expect(resolveSignalAccount({ cfg, accountId: "work" }).transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8181,
    });
  });

  it("does not reserve an implicit managed port for a disabled account", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            dormant: {
              enabled: false,
              account: "+15555550123",
              transport: { kind: "managed-native" },
            },
            work: {
              account: "+15555550124",
              transport: { kind: "managed-native" },
            },
          },
        },
      },
    } as never;

    expect(resolveSignalAccount({ cfg, accountId: "work" }).transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8080,
    });
  });

  it("rejects an explicit managed port used by a local external endpoint", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            proxy: {
              account: "+15555550123",
              transport: { kind: "container", url: "http://localhost:8181" },
            },
            work: {
              account: "+15555550124",
              transport: { kind: "managed-native", httpPort: 8181 },
            },
          },
        },
      },
    } as never;

    expect(() => resolveSignalAccount({ cfg, accountId: "work" })).toThrow(
      'Signal managed native account "work" binds port 8181, which conflicts with account "proxy" local transport endpoint.',
    );
  });

  it("rejects an explicit managed port used by its own independent local endpoint", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: {
            kind: "managed-native",
            url: "https://127.0.0.1:8181",
            httpPort: 8181,
          },
        },
      },
    } as never;

    expect(() => resolveSignalAccount({ cfg })).toThrow(
      'Signal managed native account "default" binds port 8181, which conflicts with its local transport endpoint.',
    );
  });

  it("does not let an unconfigured placeholder consume a managed port", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            placeholder: { enabled: false },
            work: { account: "+15555550124", transport: { kind: "managed-native" } },
          },
        },
      },
    } as never;

    expect(resolveSignalAccount({ cfg, accountId: "work" }).transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8080,
    });
  });

  it("keeps an implicit managed connection URL aligned with its allocated bind", () => {
    const cfg = {
      channels: {
        signal: {
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
    } as never;

    expect(resolveSignalAccount({ cfg, accountId: "work" }).transport).toMatchObject({
      kind: "managed-native",
      baseUrl: "http://127.0.0.1:8081",
      httpHost: "0.0.0.0",
      httpPort: 8081,
    });
  });

  it("reserves managed bind and local connection ports for implicit accounts", () => {
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
            work: { account: "+15555550124", transport: { kind: "managed-native" } },
          },
        },
      },
    } as never;

    expect(resolveSignalAccount({ cfg, accountId: "work" }).transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8081,
    });
  });

  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          accounts: {
            work: { enabled: false },
          },
        },
      },
    } as never;

    expect(listSignalAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultSignalAccountId(cfg)).toBe("default");
    expect(resolveSignalAccount({ cfg }).config.account).toBe("+15555550123");
  });

  it("deduplicates a case-preserving default account from the implicit root transport", () => {
    const cfg = {
      channels: {
        signal: {
          transport: {
            kind: "container",
            url: "http://signal-container:8080",
          },
          accounts: {
            Default: { account: "+15555550123" },
          },
        },
      },
    } as never;

    expect(listSignalAccountIds(cfg)).toEqual(["default"]);
    expect(resolveSignalAccount({ cfg }).config.account).toBe("+15555550123");
  });

  it("does not treat accountUuid as an implicit configured default account", () => {
    const cfg = {
      channels: {
        signal: {
          accountUuid: "123e4567-e89b-12d3-a456-426614174000",
          accounts: {
            work: { account: "+15555550123" },
          },
        },
      },
    } as never;

    expect(listSignalAccountIds(cfg)).toEqual(["work"]);
    expect(resolveSignalAccount({ cfg, accountId: "default" }).configured).toBe(false);
    expect(resolveSignalAccount({ cfg }).accountId).toBe("work");
  });

  it("keeps accountUuid supplemental when no E.164 account or transport exists", () => {
    const cfg = {
      channels: {
        signal: {
          accountUuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      },
    } as never;

    expect(listSignalAccountIds(cfg)).toEqual(["default"]);
    expect(resolveSignalAccount({ cfg }).configured).toBe(false);
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const resolved = resolveSignalAccount({
      cfg: {
        channels: {
          signal: {
            defaultAccount: "work",
            accounts: {
              work: {
                name: "Work",
                account: "+15555550123",
                transport: {
                  kind: "external-native",
                  url: "http://127.0.0.1:9999",
                },
              },
            },
          },
        },
      } as never,
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.baseUrl).toBe("http://127.0.0.1:9999");
    expect(resolved.transport).toEqual({
      kind: "external-native",
      baseUrl: "http://127.0.0.1:9999",
    });
    expect(resolved.config.account).toBe("+15555550123");
    expect(resolved.configured).toBe(true);
  });
});
