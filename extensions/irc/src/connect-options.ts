// Irc plugin module implements connect options behavior.
import { assertSecretOwnerAvailable } from "openclaw/plugin-sdk/channel-secret-owner-runtime";
import type { ResolvedIrcAccount } from "./accounts.js";
import type { IrcClientOptions } from "./client.js";

type IrcConnectOverrides = Omit<
  Partial<IrcClientOptions>,
  "host" | "port" | "tls" | "nick" | "username" | "realname" | "password" | "nickserv"
>;

export function buildIrcConnectOptions(
  account: ResolvedIrcAccount,
  overrides: IrcConnectOverrides = {},
): IrcClientOptions {
  assertSecretOwnerAvailable("account", `irc:${account.accountId}`);
  if (account.tokenStatus === "configured_unavailable") {
    throw new Error(
      `IRC credentials for account "${account.accountId}" are configured but unavailable.`,
    );
  }

  return {
    host: account.host,
    port: account.port,
    tls: account.tls,
    nick: account.nick,
    username: account.username,
    realname: account.realname,
    password: account.password,
    nickserv: {
      enabled: account.config.nickserv?.enabled,
      service: account.config.nickserv?.service,
      password: account.config.nickserv?.password,
      register: account.config.nickserv?.register,
      registerEmail: account.config.nickserv?.registerEmail,
    },
    ...overrides,
  };
}
