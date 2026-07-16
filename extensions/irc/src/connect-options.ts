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
