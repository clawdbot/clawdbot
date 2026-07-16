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
});
