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

  it.each([
    {
      name: "uses a managed native connection URL independently from its daemon bind",
      transport: {
        kind: "managed-native",
        url: "http://127.0.0.1:8181",
        httpHost: "0.0.0.0",
        httpPort: 8181,
      },
      expected: { baseUrl: "http://127.0.0.1:8181", httpHost: "0.0.0.0", httpPort: 8181 },
    },
    {
      name: "formats an IPv6 managed native bind as a valid connection URL",
      transport: { kind: "managed-native", httpHost: "::1", httpPort: 8181 },
      expected: { baseUrl: "http://[::1]:8181", httpHost: "::1", httpPort: 8181 },
    },
    {
      name: "canonicalizes a bracketed IPv6 managed native bind",
      transport: { kind: "managed-native", httpHost: "[::1]", httpPort: 8181 },
      expected: { baseUrl: "http://[::1]:8181", httpHost: "::1", httpPort: 8181 },
    },
    {
      name: "does not reserve a managed transport's own implicit connection endpoint",
      transport: {
        kind: "managed-native",
        url: "http://127.0.0.1:8080",
        httpHost: "0.0.0.0",
      },
      expected: { baseUrl: "http://127.0.0.1:8080", httpHost: "0.0.0.0", httpPort: 8080 },
    },
    {
      name: "preserves a same-port connection URL on a different specific bind address",
      transport: {
        kind: "managed-native",
        url: "http://127.0.0.1:8080",
        httpHost: "127.0.0.2",
      },
      expected: { baseUrl: "http://127.0.0.1:8080", httpHost: "127.0.0.2", httpPort: 8081 },
    },
  ])("$name", ({ transport, expected }) => {
    const cfg = { channels: { signal: { transport } } } as never;

    expect(resolveSignalAccount({ cfg }).transport).toMatchObject({
      kind: "managed-native",
      ...expected,
    });
  });

  it("does not inherit the default account transport into named accounts", () => {
    const cfg = {
      channels: {
        signal: {
          transport: { kind: "container", url: "http://default-container:8080" },
          accounts: { work: { account: "+15555550123" } },
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

  it.each([
    {
      name: "matches case-preserving account keys while allocating implicit ports",
      accounts: {
        alpha: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
        },
        Ops: { account: "+15555550124", transport: { kind: "managed-native" } },
      },
      accountId: "Ops",
      httpPort: 8081,
    },
    {
      name: "does not let a disabled account block an active managed port",
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
      accountId: "work",
      httpPort: 8181,
    },
    {
      name: "does not reserve an implicit managed port for a disabled account",
      accounts: {
        dormant: {
          enabled: false,
          account: "+15555550123",
          transport: { kind: "managed-native" },
        },
        work: { account: "+15555550124", transport: { kind: "managed-native" } },
      },
      accountId: "work",
      httpPort: 8080,
    },
    {
      name: "does not let an unconfigured placeholder consume a managed port",
      accounts: {
        placeholder: { enabled: false },
        work: { account: "+15555550124", transport: { kind: "managed-native" } },
      },
      accountId: "work",
      httpPort: 8080,
    },
    {
      name: "reserves managed bind and local connection ports for implicit accounts",
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
      accountId: "work",
      httpPort: 8081,
    },
  ])("$name", ({ accounts, accountId, httpPort }) => {
    const cfg = { channels: { signal: { accounts } } } as never;

    expect(resolveSignalAccount({ cfg, accountId }).transport).toMatchObject({
      kind: "managed-native",
      httpPort,
    });
  });

  it.each([
    {
      name: "rejects duplicate explicit managed native ports",
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
      message: 'Signal managed native accounts "work" and "personal" both bind port 8181.',
    },
    {
      name: "rejects an explicit managed port used by a local external endpoint",
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
      message:
        'Signal managed native account "work" binds port 8181, which conflicts with account "proxy" local transport endpoint.',
    },
  ])("$name", ({ accounts, message }) => {
    const cfg = { channels: { signal: { accounts } } } as never;

    expect(() => resolveSignalAccount({ cfg, accountId: "work" })).toThrow(message);
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

  it("binds autoStart daemon to a non-default local connection URL port when httpPort is omitted", () => {
    // Repro for #116165: httpUrl/port only, no httpPort → previously bound 8080 while probing 8082.
    const cfg = {
      channels: {
        signal: {
          transport: {
            kind: "managed-native",
            url: "http://127.0.0.1:8082",
          },
        },
      },
    } as never;

    expect(resolveSignalAccount({ cfg }).transport).toMatchObject({
      kind: "managed-native",
      baseUrl: "http://127.0.0.1:8082",
      httpHost: "127.0.0.1",
      httpPort: 8082,
    });
  });

  it("allocates distinct ports for two URL-only accounts that share 8082", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            a: {
              account: "+10000000001",
              transport: { kind: "managed-native", url: "http://127.0.0.1:8082" },
            },
            b: {
              account: "+10000000002",
              transport: { kind: "managed-native", url: "http://127.0.0.1:8082" },
            },
          },
        },
      },
    } as never;

    const accountA = resolveSignalAccount({ cfg, accountId: "a" });
    const accountB = resolveSignalAccount({ cfg, accountId: "b" });
    expect(accountA.transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8082,
      baseUrl: "http://127.0.0.1:8082",
    });
    // Second account falls back; bind and probe URL must stay aligned.
    expect(accountB.transport.kind).toBe("managed-native");
    if (accountB.transport.kind !== "managed-native") {
      throw new Error("expected managed-native");
    }
    expect(accountB.transport.httpPort).not.toBe(8082);
    expect(accountB.transport.baseUrl).toBe(`http://127.0.0.1:${accountB.transport.httpPort}`);
  });

  it("falls back and rewrites URL when a sibling local endpoint already reserves 8082", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            sibling: {
              account: "+10000000001",
              transport: { kind: "external-native", url: "http://127.0.0.1:8082" },
            },
            managed: {
              account: "+10000000002",
              transport: { kind: "managed-native", url: "http://127.0.0.1:8082" },
            },
          },
        },
      },
    } as never;

    const managed = resolveSignalAccount({ cfg, accountId: "managed" });
    expect(managed.transport.kind).toBe("managed-native");
    if (managed.transport.kind !== "managed-native") {
      throw new Error("expected managed-native");
    }
    expect(managed.transport.httpPort).not.toBe(8082);
    expect(managed.transport.baseUrl).toBe(`http://127.0.0.1:${managed.transport.httpPort}`);
  });

  it("keeps remote and https connection URLs independent of managed bind allocation", () => {
    const remoteCfg = {
      channels: {
        signal: {
          transport: {
            kind: "managed-native",
            url: "http://signal.example.com:8082",
          },
        },
      },
    } as never;
    const remote = resolveSignalAccount({ cfg: remoteCfg });
    expect(remote.transport).toMatchObject({
      kind: "managed-native",
      baseUrl: "http://signal.example.com:8082",
      httpPort: 8080,
    });

    const httpsCfg = {
      channels: {
        signal: {
          transport: {
            kind: "managed-native",
            url: "https://127.0.0.1:8082",
          },
        },
      },
    } as never;
    const httpsAccount = resolveSignalAccount({ cfg: httpsCfg });
    expect(httpsAccount.transport).toMatchObject({
      kind: "managed-native",
      baseUrl: "https://127.0.0.1:8082",
      httpPort: 8080,
    });
  });

  it("prefers explicit httpPort over a divergent local connection URL port", () => {
    const cfg = {
      channels: {
        signal: {
          transport: {
            kind: "managed-native",
            url: "http://127.0.0.1:8082",
            httpPort: 9090,
          },
        },
      },
    } as never;
    // Explicit bind with non-aligned URL: independent endpoint (URL not rewritten).
    expect(resolveSignalAccount({ cfg }).transport).toMatchObject({
      kind: "managed-native",
      baseUrl: "http://127.0.0.1:8082",
      httpPort: 9090,
    });
  });

  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          accounts: { work: { enabled: false } },
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
          transport: { kind: "container", url: "http://signal-container:8080" },
          accounts: { Default: { account: "+15555550123" } },
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
          accounts: { work: { account: "+15555550123" } },
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
        signal: { accountUuid: "123e4567-e89b-12d3-a456-426614174000" },
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
                transport: { kind: "external-native", url: "http://127.0.0.1:9999" },
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
