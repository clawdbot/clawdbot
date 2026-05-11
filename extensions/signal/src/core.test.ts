import {
  createMessageReceiptFromOutboundResults,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-message";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createPluginSetupWizardStatus } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { signalPlugin } from "./channel.js";
import * as clientModule from "./client-adapter.js";
import { classifySignalCliLogLine } from "./daemon.js";
import {
  looksLikeUuid,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
} from "./identity.js";
import { probeSignal } from "./probe.js";
import { clearSignalRuntime } from "./runtime.js";
import {
  normalizeSignalAccountInput,
  parseSignalAllowFromEntries,
  signalDmPolicy,
} from "./setup-core.js";

const getSignalSetupStatus = createPluginSetupWizardStatus(signalPlugin);

describe("looksLikeUuid", () => {
  it("accepts hyphenated UUIDs", () => {
    expect(looksLikeUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  it("accepts compact UUIDs", () => {
    expect(looksLikeUuid("123e4567e89b12d3a456426614174000")).toBe(true); // pragma: allowlist secret
  });

  it("accepts uuid-like hex values with letters", () => {
    expect(looksLikeUuid("abcd-1234")).toBe(true);
  });

  it("rejects numeric ids and phone-like values", () => {
    expect(looksLikeUuid("1234567890")).toBe(false);
    expect(looksLikeUuid("+15555551212")).toBe(false);
  });
});

describe("signal sender identity", () => {
  it("prefers sourceNumber over sourceUuid", () => {
    const sender = resolveSignalSender({
      sourceNumber: " +15550001111 ",
      sourceUuid: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(sender).toEqual({
      kind: "phone",
      raw: "+15550001111",
      e164: "+15550001111",
    });
  });

  it("uses sourceUuid when sourceNumber is missing", () => {
    const sender = resolveSignalSender({
      sourceUuid: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(sender).toEqual({
      kind: "uuid",
      raw: "123e4567-e89b-12d3-a456-426614174000",
    });
  });

  it("maps uuid senders to recipient and peer ids", () => {
    const sender = { kind: "uuid", raw: "123e4567-e89b-12d3-a456-426614174000" } as const;
    expect(resolveSignalRecipient(sender)).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(resolveSignalPeerId(sender)).toBe("uuid:123e4567-e89b-12d3-a456-426614174000");
  });
});

describe("probeSignal", () => {
  it("falls back to the direct probe helper when runtime is not initialized", async () => {
    clearSignalRuntime();
    vi.spyOn(clientModule, "signalCheck")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        error: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        error: null,
      });
    vi.spyOn(clientModule, "signalRpcRequest")
      .mockResolvedValueOnce({ version: "0.13.22" })
      .mockResolvedValueOnce({ version: "0.13.22" });

    const params = {
      cfg: {} as never,
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        baseUrl: "http://127.0.0.1:8080",
      } as never,
      timeoutMs: 1000,
    };

    const expected = await probeSignal("http://127.0.0.1:8080", 1000);
    const result = await signalPlugin.status!.probeAccount!(params);

    expect(result.ok).toBe(expected.ok);
    expect(result.status).toBe(expected.status);
    expect(result.error).toBe(expected.error);
    expect(result.version).toBe(expected.version);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("extracts version from {version} result", async () => {
    vi.spyOn(clientModule, "signalCheck").mockResolvedValueOnce({
      ok: true,
      status: 200,
      error: null,
    });
    vi.spyOn(clientModule, "signalRpcRequest").mockResolvedValueOnce({ version: "0.13.22" });

    const res = await probeSignal("http://127.0.0.1:8080", 1000);

    expect(res.ok).toBe(true);
    expect(res.version).toBe("0.13.22");
    expect(res.status).toBe(200);
  });

  it("returns ok=false when /check fails", async () => {
    vi.spyOn(clientModule, "signalCheck").mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: "HTTP 503",
    });

    const res = await probeSignal("http://127.0.0.1:8080", 1000);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.version).toBe(null);
  });

  it("setup status lines use the selected account cliPath", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            cliPath: "/tmp/root-signal-cli",
            accounts: {
              work: {
                cliPath: "/tmp/work-signal-cli",
              },
            },
          },
        },
      } as never,
      accountOverrides: { signal: "work" },
    });

    expect(status.statusLines).toContain("signal-cli: missing (/tmp/work-signal-cli)");
  });

  it("setup status uses configured defaultAccount for omitted cliPath lookup", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            cliPath: "/tmp/root-signal-cli",
            defaultAccount: "work",
            accounts: {
              work: {
                cliPath: "/tmp/work-signal-cli",
              },
            },
          },
        },
      } as never,
      accountOverrides: {},
    });

    expect(status.statusLines).toContain("signal-cli: missing (/tmp/work-signal-cli)");
  });

  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            defaultAccount: "work",
            cliPath: "/tmp/root-signal-cli",
            accounts: {
              alerts: {
                cliPath: "/tmp/alerts-signal-cli",
              },
              work: {
                cliPath: "",
                account: "",
                httpHost: "",
                httpUrl: "",
              },
            },
          },
        },
      } as OpenClawConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
  });
});

describe("signal outbound", () => {
  it("chunks outbound text without requiring Signal runtime initialization", () => {
    clearSignalRuntime();
    const chunker = signalPlugin.outbound?.chunker;
    if (!chunker) {
      throw new Error("signal outbound.chunker unavailable");
    }

    expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  });

  it("declares message adapter durable text and media with receipt proofs", async () => {
    const send = vi.fn(async (_to: string, _text: string, opts: { mediaUrl?: string } = {}) => {
      const messageId = opts.mediaUrl ? "signal-media-1" : "signal-text-1";
      return {
        messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "signal", messageId }],
          kind: opts.mediaUrl ? "media" : "text",
        }),
      };
    });
    const deps = { signal: send };

    const proofResults = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "signal",
      adapter: signalPlugin.message!,
      proofs: {
        text: async () => {
          const result = await signalPlugin.message?.send?.text?.({
            cfg: {} as OpenClawConfig,
            to: "signal:+15555550123",
            text: "hello",
            deps,
          } as Parameters<NonNullable<typeof signalPlugin.message.send.text>>[0] & {
            deps: typeof deps;
          });
          expect(send).toHaveBeenCalledWith("signal:+15555550123", "hello", {
            cfg: {},
            maxBytes: undefined,
            accountId: undefined,
          });
          expect(result?.receipt.platformMessageIds).toEqual(["signal-text-1"]);
        },
        media: async () => {
          const result = await signalPlugin.message?.send?.media?.({
            cfg: {} as OpenClawConfig,
            to: "signal:+15555550123",
            text: "image",
            mediaUrl: "https://example.com/image.png",
            deps,
          } as Parameters<NonNullable<typeof signalPlugin.message.send.media>>[0] & {
            deps: typeof deps;
          });
          expect(send).toHaveBeenCalledWith("signal:+15555550123", "image", {
            cfg: {},
            mediaUrl: "https://example.com/image.png",
            maxBytes: undefined,
            accountId: undefined,
          });
          expect(result?.receipt.platformMessageIds).toEqual(["signal-media-1"]);
        },
      },
    });

    expect(proofResults).toEqual([
      { capability: "text", status: "verified" },
      { capability: "media", status: "verified" },
      { capability: "payload", status: "not_declared" },
      { capability: "silent", status: "not_declared" },
      { capability: "replyTo", status: "not_declared" },
      { capability: "thread", status: "not_declared" },
      { capability: "nativeQuote", status: "not_declared" },
      { capability: "messageSendingHooks", status: "not_declared" },
      { capability: "batch", status: "not_declared" },
      { capability: "reconcileUnknownSend", status: "not_declared" },
      { capability: "afterSendSuccess", status: "not_declared" },
      { capability: "afterCommit", status: "not_declared" },
    ]);
  });
});

describe("classifySignalCliLogLine", () => {
  it("treats INFO/DEBUG as log", () => {
    expect(classifySignalCliLogLine("INFO  DaemonCommand - Started")).toBe("log");
    expect(classifySignalCliLogLine("DEBUG Something")).toBe("log");
  });

  it("treats WARN/ERROR as error", () => {
    expect(classifySignalCliLogLine("WARN  Something")).toBe("error");
    expect(classifySignalCliLogLine("WARNING Something")).toBe("error");
    expect(classifySignalCliLogLine("ERROR Something")).toBe("error");
  });

  it("treats failures without explicit severity as error", () => {
    expect(classifySignalCliLogLine("Failed to initialize HTTP Server - oops")).toBe("error");
    expect(classifySignalCliLogLine('Exception in thread "main"')).toBe("error");
  });

  it("returns null for empty lines", () => {
    expect(classifySignalCliLogLine("")).toBe(null);
    expect(classifySignalCliLogLine("   ")).toBe(null);
  });
});

describe("signal setup parsing", () => {
  it("accepts already normalized numbers", () => {
    expect(normalizeSignalAccountInput("+15555550123")).toBe("+15555550123");
  });

  it("normalizes valid E.164 numbers", () => {
    expect(normalizeSignalAccountInput(" +1 (555) 555-0123 ")).toBe("+15555550123");
  });

  it("rejects empty input", () => {
    expect(normalizeSignalAccountInput("   ")).toBeNull();
  });

  it("rejects invalid values", () => {
    expect(normalizeSignalAccountInput("abc")).toBeNull();
    expect(normalizeSignalAccountInput("++--")).toBeNull();
  });

  it("rejects inputs with stray + characters", () => {
    expect(normalizeSignalAccountInput("++12345")).toBeNull();
    expect(normalizeSignalAccountInput("+1+2345")).toBeNull();
  });

  it("rejects numbers that are too short or too long", () => {
    expect(normalizeSignalAccountInput("+1234")).toBeNull();
    expect(normalizeSignalAccountInput("+1234567890123456")).toBeNull();
  });

  it("parses e164, uuid and wildcard entries", () => {
    expect(
      parseSignalAllowFromEntries("+15555550123, uuid:123e4567-e89b-12d3-a456-426614174000, *"),
    ).toEqual({
      entries: ["+15555550123", "uuid:123e4567-e89b-12d3-a456-426614174000", "*"],
    });
  });

  it("normalizes bare uuid values", () => {
    expect(parseSignalAllowFromEntries("123e4567-e89b-12d3-a456-426614174000")).toEqual({
      entries: ["uuid:123e4567-e89b-12d3-a456-426614174000"],
    });
  });

  it("returns validation errors for invalid entries", () => {
    expect(parseSignalAllowFromEntries("uuid:")).toEqual({
      entries: [],
      error: "Invalid uuid entry",
    });
    expect(parseSignalAllowFromEntries("invalid")).toEqual({
      entries: [],
      error: "Invalid entry: invalid",
    });
  });

  it("reads the named-account DM policy instead of the channel root", () => {
    expect(
      signalDmPolicy.getCurrent(
        {
          channels: {
            signal: {
              dmPolicy: "disabled",
              accounts: {
                work: {
                  account: "+15555550123",
                  dmPolicy: "allowlist",
                },
              },
            },
          },
        },
        "work",
      ),
    ).toBe("allowlist");
  });

  it("reports account-scoped config keys for named accounts", () => {
    expect(signalDmPolicy.resolveConfigKeys?.({ channels: { signal: {} } }, "work")).toEqual({
      policyKey: "channels.signal.accounts.work.dmPolicy",
      allowFromKey: "channels.signal.accounts.work.allowFrom",
    });
  });

  it("uses configured defaultAccount for omitted DM policy account context", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          defaultAccount: "work",
          dmPolicy: "disabled",
          allowFrom: ["+15555550123"],
          accounts: {
            work: {
              account: "+15555550999",
              dmPolicy: "allowlist",
            },
          },
        },
      },
    };

    expect(signalDmPolicy.getCurrent(cfg)).toBe("allowlist");
    expect(signalDmPolicy.resolveConfigKeys?.(cfg)).toEqual({
      policyKey: "channels.signal.accounts.work.dmPolicy",
      allowFromKey: "channels.signal.accounts.work.allowFrom",
    });

    const next = signalDmPolicy.setPolicy(cfg, "open");
    expect(next.channels?.signal?.dmPolicy).toBe("disabled");
    expect(next.channels?.signal?.allowFrom).toEqual(["+15555550123"]);
    expect(next.channels?.signal?.accounts?.work?.dmPolicy).toBe("open");
    expect(next.channels?.signal?.accounts?.work?.allowFrom).toEqual(["+15555550123", "*"]);
  });

  it('writes open policy state to the named account and stores inherited allowFrom with "*"', () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          allowFrom: ["+15555550123"],
          accounts: {
            work: {
              account: "+15555550999",
            },
          },
        },
      },
    };

    const next = signalDmPolicy.setPolicy(cfg, "open", "work");

    expect(next.channels?.signal?.dmPolicy).toBeUndefined();
    expect(next.channels?.signal?.allowFrom).toEqual(["+15555550123"]);
    expect(next.channels?.signal?.accounts?.work?.dmPolicy).toBe("open");
    expect(next.channels?.signal?.accounts?.work?.allowFrom).toEqual(["+15555550123", "*"]);
  });
});
