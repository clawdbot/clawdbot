import { describe, expect, it } from "vitest";
import { resolveBlueBubblesServerAccount } from "./account-resolve.js";

describe("resolveBlueBubblesServerAccount", () => {
  it("respects an explicit private-network opt-out for loopback server URLs", () => {
    expect(
      resolveBlueBubblesServerAccount({
        serverUrl: "http://127.0.0.1:1234",
        password: "test-password",
        cfg: {
          channels: {
            bluebubbles: {
              network: {
                dangerouslyAllowPrivateNetwork: false,
              },
            },
          },
        },
      }),
    ).toMatchObject({
      baseUrl: "http://127.0.0.1:1234",
      password: "test-password",
      allowPrivateNetwork: false,
    });
  });

  it("lets a legacy per-account opt-in override a channel-level canonical default", () => {
    expect(
      resolveBlueBubblesServerAccount({
        accountId: "personal",
        cfg: {
          channels: {
            bluebubbles: {
              network: {
                dangerouslyAllowPrivateNetwork: false,
              },
              accounts: {
                personal: {
                  serverUrl: "http://127.0.0.1:1234",
                  password: "test-password",
                  allowPrivateNetwork: true,
                },
              },
            },
          },
        },
      }),
    ).toMatchObject({
      accountId: "personal",
      baseUrl: "http://127.0.0.1:1234",
      password: "test-password",
      allowPrivateNetwork: true,
      allowPrivateNetworkConfig: true,
    });
  });

  it("uses accounts.default config for the default BlueBubbles account", () => {
    expect(
      resolveBlueBubblesServerAccount({
        cfg: {
          channels: {
            bluebubbles: {
              accounts: {
                default: {
                  serverUrl: "http://127.0.0.1:1234",
                  password: "test-password",
                  allowPrivateNetwork: true,
                },
              },
            },
          },
        },
      }),
    ).toMatchObject({
      accountId: "default",
      baseUrl: "http://127.0.0.1:1234",
      password: "test-password",
      allowPrivateNetwork: true,
      allowPrivateNetworkConfig: true,
    });
  });

  describe("sendTimeoutMs", () => {
    it("returns channel-level sendTimeoutMs when configured", () => {
      expect(
        resolveBlueBubblesServerAccount({
          serverUrl: "http://localhost:1234",
          password: "test-password",
          cfg: {
            channels: {
              bluebubbles: {
                sendTimeoutMs: 45_000,
              },
            },
          },
        }),
      ).toMatchObject({ sendTimeoutMs: 45_000 });
    });

    it("returns per-account sendTimeoutMs when configured", () => {
      expect(
        resolveBlueBubblesServerAccount({
          accountId: "personal",
          cfg: {
            channels: {
              bluebubbles: {
                accounts: {
                  personal: {
                    serverUrl: "http://localhost:1234",
                    password: "test-password",
                    sendTimeoutMs: 60_000,
                  },
                },
              },
            },
          },
        }),
      ).toMatchObject({ sendTimeoutMs: 60_000 });
    });

    it("returns undefined sendTimeoutMs when unconfigured (use DEFAULT_SEND_TIMEOUT_MS downstream)", () => {
      const resolved = resolveBlueBubblesServerAccount({
        serverUrl: "http://localhost:1234",
        password: "test-password",
        cfg: {},
      });
      expect(resolved.sendTimeoutMs).toBeUndefined();
    });

    it("ignores non-positive / non-integer sendTimeoutMs values", () => {
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        const resolved = resolveBlueBubblesServerAccount({
          serverUrl: "http://localhost:1234",
          password: "test-password",
          cfg: {
            channels: {
              bluebubbles: {
                // runtime might receive a malformed value via raw config; the
                // resolver must drop it so downstream falls back to the default.
                sendTimeoutMs: bad as unknown as number,
              },
            },
          },
        });
        expect(resolved.sendTimeoutMs).toBeUndefined();
      }
    });
  });
});
