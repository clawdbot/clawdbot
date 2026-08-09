// Signal tests cover doctor contract api plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import { migrateLegacySignalTransportConfig } from "./src/config-compat.js";

function signalConfig(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { signal: entry } } as never;
}

describe("signal streaming legacy config rules", () => {
  const rootRule = legacyConfigRules.find((rule) => rule.path.join(".") === "channels.signal");
  const accountRule = legacyConfigRules.find(
    (rule) => rule.path.join(".") === "channels.signal.accounts",
  );

  it("matches flat delivery aliases at root and account level", () => {
    expect(rootRule?.match?.({ chunkMode: "newline" }, {})).toBe(true);
    expect(rootRule?.match?.({ blockStreaming: true }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: { chunkMode: "newline" } }, {})).toBe(false);
    expect(accountRule?.match?.({ personal: { blockStreamingCoalesce: { idleMs: 5 } } }, {})).toBe(
      true,
    );
    expect(
      accountRule?.match?.({ personal: { streaming: { block: { enabled: true } } } }, {}),
    ).toBe(false);
  });

  it("matches retired transport fields at root and account level", () => {
    const transportRootRule = legacyConfigRules.find(
      (rule) => rule.path.join(".") === "channels.signal" && rule.message.includes("account-owned"),
    );
    const transportAccountRule = legacyConfigRules.find(
      (rule) =>
        rule.path.join(".") === "channels.signal.accounts" &&
        rule.message.includes("account-owned"),
    );

    expect(transportRootRule?.match?.({ apiMode: "auto", httpUrl: "signal:8080" }, {})).toBe(true);
    expect(transportRootRule?.match?.({ transport: { kind: "managed-native" } }, {})).toBe(false);
    expect(transportAccountRule?.match?.({ work: { httpPort: 8181 } }, {})).toBe(true);
    expect(
      transportAccountRule?.match?.(
        { work: { transport: { kind: "managed-native", httpPort: 8181 } } },
        {},
      ),
    ).toBe(false);
  });
});

describe("signal normalizeCompatibilityConfig streaming aliases", () => {
  it("moves flat delivery aliases and seeds materialized account objects from root", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        chunkMode: "newline",
        blockStreaming: true,
        accounts: {
          personal: {
            blockStreamingCoalesce: { idleMs: 250 },
          },
        },
      }),
    });

    const signal = result.config.channels?.signal as unknown as Record<string, unknown>;
    expect(signal.streaming).toEqual({ chunkMode: "newline", block: { enabled: true } });
    expect(signal.chunkMode).toBeUndefined();
    expect(signal.blockStreaming).toBeUndefined();
    const personal = expectDefined(
      (signal.accounts as Record<string, Record<string, unknown>>).personal,
      "personal signal account",
    );
    // Signal's account merge replaces the root streaming object wholesale, so
    // the account object migration materializes must carry the inherited root
    // settings or `doctor --fix` would silently drop them for this account.
    expect(personal.streaming).toEqual({
      chunkMode: "newline",
      block: { enabled: true, coalesce: { idleMs: 250 } },
    });
    expect(personal.blockStreamingCoalesce).toBeUndefined();
    expect(result.changes).toContain(
      "Copied channels.signal.streaming into channels.signal.accounts.personal.streaming to keep inherited settings while migrating flat streaming keys.",
    );
  });

  it("is idempotent: a second run reports no changes", () => {
    const first = normalizeCompatibilityConfig({
      cfg: signalConfig({
        chunkMode: "newline",
        accounts: { personal: { blockStreaming: false } },
      }),
    });
    expect(first.changes.length).toBeGreaterThan(0);

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(first.config);
  });
});

describe("signal transport compatibility", () => {
  it("migrates an explicit container mode and materializes named account ownership", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        apiMode: "container",
        httpUrl: "http://signal:8080",
        accounts: { work: { account: "+15555550123" } },
      }),
    });
    const signal = result.config.channels?.signal;

    expect(signal?.transport).toBeUndefined();
    expect(signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://signal:8080",
    });
    expect(signal).not.toHaveProperty("apiMode");
    expect(signal).not.toHaveProperty("httpUrl");
  });

  it("migrates managed native process fields into transport", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        cliPath: "/opt/signal-cli",
        configPath: "/var/lib/signal",
        httpPort: 8181,
        ignoreAttachments: true,
      }),
    });

    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      cliPath: "/opt/signal-cli",
      configPath: "/var/lib/signal",
      httpPort: 8181,
    });
    expect(result.config.channels?.signal?.ignoreAttachments).toBe(true);
    expect(result.config.channels?.signal).not.toHaveProperty("cliPath");
  });

  it("moves a sync-migrated accounts.default transport to the canonical root", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        apiMode: "native",
        accounts: {
          default: {
            account: "+15555550123",
            httpPort: 8181,
          },
        },
      }),
    });

    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      httpPort: 8181,
    });
    expect(result.config.channels?.signal?.accounts?.default).not.toHaveProperty("transport");
  });

  it("moves an async-migrated accounts.default transport to the canonical root", async () => {
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        apiMode: "native",
        accounts: {
          default: {
            account: "+15555550123",
            httpPort: 8282,
          },
        },
      }),
    });

    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      httpPort: 8282,
    });
    expect(result.config.channels?.signal?.accounts?.default).not.toHaveProperty("transport");
  });

  it("uses a shipped accounts.default endpoint override during sync migration", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        apiMode: "native",
        account: "+15555550123",
        httpUrl: "http://shadowed-root:8080",
        autoStart: false,
        accounts: {
          default: {
            httpUrl: "http://active-default:8181",
          },
        },
      }),
    });

    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://active-default:8181",
    });
    expect(result.config.channels?.signal?.accounts?.default).not.toHaveProperty("transport");
  });

  it("uses a case-preserving accounts.Default endpoint override during migration", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        apiMode: "native",
        account: "+15555550123",
        httpUrl: "http://shadowed-root:8080",
        autoStart: false,
        accounts: {
          Default: {
            account: "+15555550124",
            httpUrl: "http://active-default:8181",
            autoStart: false,
          },
        },
      }),
    });

    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://active-default:8181",
    });
    expect(result.config.channels?.signal?.accounts?.Default).not.toHaveProperty("transport");
  });

  it("does not probe a shadowed root endpoint during async migration", async () => {
    const detect = vi.fn(async ({ url }: { url: string }) => ({
      kind: "external-native" as const,
      url,
    }));
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        apiMode: "auto",
        account: "+15555550123",
        httpUrl: "http://shadowed-root:8080",
        accounts: {
          default: {
            httpUrl: "http://active-default:8181",
          },
        },
      }),
      detect,
    });

    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledWith({
      url: "http://active-default:8181",
      account: "+15555550123",
    });
    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://active-default:8181",
    });
  });

  it("preserves the root managed port when accounts.default inherits it", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        apiMode: "native",
        account: "+15555550123",
        httpPort: 8181,
        accounts: { default: {} },
      }),
    });

    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      httpPort: 8181,
    });
    expect(result.config.channels?.signal?.accounts?.default).not.toHaveProperty("transport");
  });

  it("keeps a canonical root transport authoritative while migrating accounts.default", async () => {
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        apiMode: "native",
        transport: { kind: "external-native", url: "http://canonical-native:8181" },
        accounts: { default: { account: "+15555550123" } },
      }),
    });

    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://canonical-native:8181",
    });
    expect(result.config.channels?.signal?.accounts?.default).not.toHaveProperty("transport");
  });

  it("keeps attachment suppression account-owned for external transports", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        apiMode: "container",
        httpUrl: "signal:8080",
        account: "+15555550123",
        ignoreAttachments: true,
      }),
    });

    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://signal:8080",
    });
    expect(result.config.channels?.signal?.ignoreAttachments).toBe(true);
  });

  it("defers an explicit account-less container migration", () => {
    const cfg = signalConfig({
      apiMode: "container",
      httpUrl: "http://signal:8080",
    });
    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "- channels.signal: legacy container transport requires an account number; add channels.signal.account (or the relevant channels.signal.accounts.*.account) and rerun openclaw doctor --fix.",
    ]);
  });

  it("migrates a disabled account-less container without blocking upgrade", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        enabled: false,
        apiMode: "container",
        httpUrl: "http://signal:8080",
      }),
    });

    expect(result.warnings).toBeUndefined();
    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://signal:8080",
    });
    expect(result.config.channels?.signal).not.toHaveProperty("apiMode");
    expect(result.config.channels?.signal).not.toHaveProperty("httpUrl");
  });

  it("preserves an inherited custom port for the first named managed account", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        httpPort: 8181,
        accounts: {
          work: { account: "+15555550123" },
          alerts: { account: "+15555550124" },
        },
      }),
    });

    expect(result.config.channels?.signal?.transport).toBeUndefined();
    expect(result.config.channels?.signal?.accounts?.work?.transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8181,
    });
    expect(result.config.channels?.signal?.accounts?.alerts?.transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8080,
    });
  });

  it("allocates distinct managed ports while materializing named account ownership", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        account: "+15555550123",
        httpPort: 8080,
        accounts: { work: { account: "+15555550124" } },
      }),
    });

    expect(result.config.channels?.signal?.transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8080,
    });
    expect(result.config.channels?.signal?.accounts?.work?.transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8081,
    });
  });

  it("keeps migrated managed connection URLs aligned with reassigned bind ports", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        apiMode: "native",
        autoStart: true,
        account: "+15555550123",
        httpHost: "0.0.0.0",
        httpPort: 8080,
        httpUrl: "http://127.0.0.1:8080",
        accounts: { work: { account: "+15555550124" } },
      }),
    });

    expect(result.config.channels?.signal?.transport).toMatchObject({
      kind: "managed-native",
      url: "http://127.0.0.1:8080",
      httpPort: 8080,
    });
    expect(result.config.channels?.signal?.accounts?.work?.transport).toMatchObject({
      kind: "managed-native",
      url: "http://127.0.0.1:8081",
      httpPort: 8081,
    });
  });

  it("reserves managed bind and local connection ports during migration", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        apiMode: "native",
        autoStart: true,
        account: "+15555550123",
        httpHost: "0.0.0.0",
        httpPort: 8181,
        httpUrl: "http://localhost:8080",
        accounts: { work: { account: "+15555550124" } },
      }),
    });

    expect(result.config.channels?.signal?.transport).toMatchObject({
      kind: "managed-native",
      url: "http://localhost:8080",
      httpPort: 8181,
    });
    expect(result.config.channels?.signal?.accounts?.work?.transport).toMatchObject({
      kind: "managed-native",
      url: "http://localhost:8080",
      httpPort: 8081,
    });
  });

  it("defers auto endpoint migration until doctor can detect it", () => {
    const cfg = signalConfig({ apiMode: "auto", httpUrl: "http://signal:8080" });
    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
  });

  it("does not configure an account from non-configuring legacy options", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        apiMode: "native",
        startupTimeoutMs: 60_000,
        receiveMode: "manual",
        ignoreStories: true,
      }),
    });

    expect(result.config.channels?.signal).not.toHaveProperty("transport");
    expect(result.config.channels?.signal).not.toHaveProperty("apiMode");
    expect(result.config.channels?.signal).not.toHaveProperty("startupTimeoutMs");
    expect(result.config.channels?.signal).not.toHaveProperty("receiveMode");
    expect(result.config.channels?.signal).not.toHaveProperty("ignoreStories");
  });

  it("detects an auto endpoint once and persists the concrete result", async () => {
    const detect = vi.fn().mockResolvedValue({
      kind: "external-native",
      url: "http://signal:8080",
    });
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        apiMode: "auto",
        httpUrl: "http://signal:8080/",
        account: "+15555550123",
      }),
      detect,
    });

    expect(detect).toHaveBeenCalledWith({
      url: "http://signal:8080",
      account: "+15555550123",
    });
    expect(detect).toHaveBeenCalledTimes(1);
    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://signal:8080",
    });
    expect(result.config.channels?.signal).not.toHaveProperty("apiMode");

    const second = await migrateLegacySignalTransportConfig({ cfg: result.config, detect });
    expect(second.config).toBe(result.config);
    expect(second.changes).toEqual([]);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("defers an account-less auto endpoint detected as a container", async () => {
    const detect = vi.fn().mockResolvedValue({
      kind: "container",
      url: "http://signal:8080",
    });
    const cfg = signalConfig({
      apiMode: "auto",
      autoStart: false,
      httpUrl: "http://signal:8080",
    });
    const result = await migrateLegacySignalTransportConfig({
      cfg,
      detect,
    });

    expect(detect).toHaveBeenCalledTimes(1);
    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "- channels.signal: legacy container transport requires an account number; add channels.signal.account (or the relevant channels.signal.accounts.*.account) and rerun openclaw doctor --fix.",
    ]);
  });

  it("detects explicit auto endpoints even when legacy autoStart is true", async () => {
    const detect = vi.fn().mockResolvedValue({
      kind: "container",
      url: "http://signal:8080",
    });
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        apiMode: "auto",
        autoStart: true,
        httpUrl: "http://signal:8080",
        account: "+15555550123",
      }),
      detect,
    });

    expect(detect).toHaveBeenCalledTimes(1);
    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://signal:8080",
    });
  });

  it("keeps an auto-detected native endpoint managed when autoStart is true", async () => {
    const detect = vi.fn().mockResolvedValue({
      kind: "external-native",
      url: "http://127.0.0.1:8181",
    });
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        apiMode: "auto",
        autoStart: true,
        httpUrl: "http://127.0.0.1:8181",
        httpHost: "0.0.0.0",
        httpPort: 8181,
      }),
      detect,
    });

    expect(detect).toHaveBeenCalledTimes(1);
    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      url: "http://127.0.0.1:8181",
      httpHost: "0.0.0.0",
      httpPort: 8181,
    });
  });

  it("detects auto host and port endpoints before choosing a concrete transport", async () => {
    const detect = vi.fn().mockResolvedValue({
      kind: "container",
      url: "http://signal:8181",
    });
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        apiMode: "auto",
        autoStart: false,
        httpHost: "signal",
        httpPort: 8181,
        account: "+15555550123",
      }),
      detect,
    });

    expect(detect).toHaveBeenCalledWith({
      url: "http://signal:8181",
      account: "+15555550123",
    });
    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://signal:8181",
    });
  });

  it("keeps a supplemental root UUID from creating a default transport", async () => {
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        accountUuid: "123e4567-e89b-12d3-a456-426614174000",
        apiMode: "native",
        autoStart: true,
        httpPort: 8181,
        accounts: {
          work: { account: "+15555550123" },
        },
      }),
    });

    expect(result.config.channels?.signal?.transport).toBeUndefined();
    expect(result.config.channels?.signal?.accountUuid).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );
    expect(result.config.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "managed-native",
      httpPort: 8181,
    });
  });

  it("keeps explicit native auto-start endpoints managed", async () => {
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        apiMode: "native",
        autoStart: true,
        httpHost: "127.0.0.1",
        httpPort: 8181,
        httpUrl: "http://127.0.0.1:8181",
      }),
    });

    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      httpHost: "127.0.0.1",
      httpPort: 8181,
    });
  });

  it("ignores legacy native URL paths when the daemon bind matches", async () => {
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        apiMode: "native",
        autoStart: true,
        httpHost: "127.0.0.1",
        httpPort: 8181,
        httpUrl: "http://127.0.0.1:8181/proxy",
      }),
    });

    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      httpHost: "127.0.0.1",
      httpPort: 8181,
    });
  });

  it("preserves an independent managed connection URL", async () => {
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        apiMode: "native",
        autoStart: true,
        httpHost: "0.0.0.0",
        httpPort: 8181,
        httpUrl: "http://127.0.0.1:8181",
      }),
    });

    expect(result.warnings).toBeUndefined();
    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      url: "http://127.0.0.1:8181",
      httpHost: "0.0.0.0",
      httpPort: 8181,
    });
  });

  it("defers malformed legacy HTTP URLs instead of aborting doctor", async () => {
    const cfg = signalConfig({
      apiMode: "native",
      autoStart: true,
      httpUrl: "http://[bad",
    });

    expect(() => normalizeCompatibilityConfig({ cfg })).not.toThrow();
    const result = await migrateLegacySignalTransportConfig({ cfg });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "- channels.signal: legacy httpUrl is invalid; keep the current config, correct httpUrl, then run openclaw doctor --fix.",
    ]);
  });

  it("defers legacy managed ports outside the canonical range", async () => {
    const cfg = signalConfig({
      apiMode: "native",
      autoStart: true,
      httpPort: 70_000,
    });
    const result = await migrateLegacySignalTransportConfig({ cfg });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "- channels.signal: legacy httpPort must be an integer between 1 and 65535; correct httpPort, then run openclaw doctor --fix.",
    ]);
  });

  it("defers invalid ports used to derive external legacy endpoints", async () => {
    const cfg = signalConfig({
      apiMode: "container",
      httpHost: "127.0.0.1",
      httpPort: 70_000,
    });
    const result = await migrateLegacySignalTransportConfig({ cfg });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "- channels.signal: legacy httpPort must be an integer between 1 and 65535; correct httpPort, then run openclaw doctor --fix.",
    ]);
  });

  it.each(["bad host", "signal.example/proxy", "signal.example?mode=native"])(
    "defers malformed host %s used to derive legacy endpoints",
    async (httpHost) => {
      const cfg = signalConfig({
        apiMode: "native",
        autoStart: true,
        httpHost,
      });

      expect(() => normalizeCompatibilityConfig({ cfg })).not.toThrow();
      const result = await migrateLegacySignalTransportConfig({ cfg });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([
        "- channels.signal: legacy httpHost is invalid; keep the current config, correct httpHost, then run openclaw doctor --fix.",
      ]);
    },
  );

  it("ignores a retired bind port when an explicit container URL owns the endpoint", async () => {
    const result = await migrateLegacySignalTransportConfig({
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            apiMode: "container",
            httpUrl: "http://signal-container:8080",
            httpPort: 70_000,
          },
        },
      } as never,
    });

    expect(result.warnings).toBeUndefined();
    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://signal-container:8080",
    });
    expect(result.config.channels?.signal).not.toHaveProperty("httpPort");
  });

  it("keeps canonical transport authoritative over retired malformed URLs", async () => {
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        transport: { kind: "external-native", url: "http://canonical-native:8181" },
        apiMode: "native",
        httpUrl: "http://[bad",
      }),
    });

    expect(result.warnings).toBeUndefined();
    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://canonical-native:8181",
    });
    expect(result.config.channels?.signal).not.toHaveProperty("apiMode");
    expect(result.config.channels?.signal).not.toHaveProperty("httpUrl");
  });

  it("ignores discarded root transport state for named-account migration", async () => {
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        apiMode: "container",
        httpUrl: "http://[bad",
        accounts: {
          work: { account: "+15555550123", httpUrl: "http://signal-work:8080" },
          alerts: { account: "+15555550124", httpUrl: "http://signal-alerts:8080" },
        },
      }),
    });

    expect(result.warnings).toBeUndefined();
    expect(result.config.channels?.signal?.transport).toBeUndefined();
    expect(result.config.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://signal-work:8080",
    });
    expect(result.config.channels?.signal?.accounts?.alerts?.transport).toEqual({
      kind: "container",
      url: "http://signal-alerts:8080",
    });
  });

  it("defers a malformed root URL inherited by named accounts", async () => {
    const cfg = signalConfig({
      apiMode: "container",
      httpUrl: "http://[bad",
      accounts: {
        work: { account: "+15555550123" },
      },
    });
    const result = await migrateLegacySignalTransportConfig({ cfg });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "- channels.signal: legacy httpUrl is invalid; keep the current config, correct httpUrl, then run openclaw doctor --fix.",
    ]);
  });

  it("keeps an unreachable ambiguous auto endpoint pending with an explicit selection path", async () => {
    const cfg = signalConfig({ apiMode: "auto", httpUrl: "http://offline:8080" });
    const result = await migrateLegacySignalTransportConfig({
      cfg,
      detect: vi.fn().mockRejectedValue(new Error("offline")),
    });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "- channels.signal: legacy auto transport is ambiguous while its endpoint is unavailable; bring the endpoint online and rerun openclaw doctor --fix, or replace the retired fields with an explicit account-owned transport in openclaw.json.",
    ]);
  });

  it("preserves managed ownership when an explicit auto-start endpoint is offline", async () => {
    const detect = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await migrateLegacySignalTransportConfig({
      cfg: signalConfig({
        apiMode: "auto",
        autoStart: true,
        httpUrl: "http://127.0.0.1:8181",
        httpHost: "127.0.0.1",
        httpPort: 8181,
      }),
      detect,
    });

    expect(detect).toHaveBeenCalledTimes(1);
    expect(result.config.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      httpHost: "127.0.0.1",
      httpPort: 8181,
    });
    expect(result.warnings).toBeUndefined();
  });
});
