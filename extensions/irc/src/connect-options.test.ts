// Irc tests cover connect options plugin behavior.
import { describe, expect, it } from "vitest";
import { buildIrcConnectOptions } from "./connect-options.js";

describe("buildIrcConnectOptions", () => {
  const account = {
    accountId: "default",
    enabled: true,
    configured: true,
    host: "irc.libera.chat",
    port: 6697,
    tls: true,
    nick: "openclaw",
    username: "openclaw",
    realname: "OpenClaw Bot",
    password: "server-pass",
    passwordSource: "config" as const,
    config: {
      nickserv: {
        enabled: true,
        service: "NickServ",
        password: "nickserv-pass",
        register: true,
        registerEmail: "bot@example.com",
      },
    },
  };

  it("copies resolved account connection fields and NickServ config", () => {
    expect(
      buildIrcConnectOptions(account, {
        connectTimeoutMs: 1234,
      }),
    ).toEqual({
      host: "irc.libera.chat",
      port: 6697,
      tls: true,
      nick: "openclaw",
      username: "openclaw",
      realname: "OpenClaw Bot",
      password: "server-pass",
      nickserv: {
        enabled: true,
        service: "NickServ",
        password: "nickserv-pass",
        register: true,
        registerEmail: "bot@example.com",
      },
      connectTimeoutMs: 1234,
    });
  });

  it("rejects unavailable credentials before constructing an IRC connection", () => {
    expect(() =>
      buildIrcConnectOptions({ ...account, password: "", tokenStatus: "configured_unavailable" }),
    ).toThrow(/configured but unavailable/i);
  });
});
