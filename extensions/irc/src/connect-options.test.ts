import { describe, expect, it } from "vitest";
import { buildIrcConnectOptions } from "./connect-options.js";

describe("buildIrcConnectOptions", () => {
  it("copies resolved account connection fields and NickServ config", () => {
    const account = {
      host: "irc.libera.chat",
      port: 6697,
      tls: true,
      nick: "openclaw",
      username: "openclaw",
      realname: "OpenClaw Bot",
      password: "server-pass",
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

    expect(
      buildIrcConnectOptions(account as never, {
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
});
