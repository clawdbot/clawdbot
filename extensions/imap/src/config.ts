import type { IdentifierAuthentication } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const SENDER_STRENGTHS = [
  "mutable",
  "unverified",
  "asserted",
  "verified",
] as const satisfies readonly IdentifierAuthentication[];
type HookDispatch = OpenClawPluginApi["runtime"]["hooks"]["dispatchHookAgentTurn"];

export type ImapAccountConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
  watch: { mode: "auto" | "idle" | "interval"; pollSeconds: number };
  allowedSenders: string[];
  senderAuth: {
    min: IdentifierAuthentication;
    trustedAuthservIds: string[];
    acceptTrustedAuthservId: boolean;
  };
  addressTokens: Array<{ token: string; senders: string[] }>;
  agentId: string;
  deliver: boolean;
  includeBody: boolean;
  maxBytes: number;
  model?: string;
  thinking?: Parameters<HookDispatch>[0]["thinking"];
  timeoutSeconds?: number;
};

export type ImapPluginConfig = { accounts: Record<string, ImapAccountConfig> };

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function resolveImapConfig(
  value: unknown,
  onUnavailableAccount?: (accountId: string) => void,
): ImapPluginConfig {
  const configured = asNonArrayRecord(asNonArrayRecord(value)?.accounts);
  const accounts: Record<string, ImapAccountConfig> = {};
  for (const [accountId, input] of Object.entries(configured ?? {})) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(accountId)) {
      throw new Error(`IMAP account id ${JSON.stringify(accountId)} is not session-safe`);
    }
    const account = asNonArrayRecord(input);
    if (!account) {
      throw new Error(`IMAP account ${accountId} must be an object`);
    }
    const { host, user, password, agentId } = account;
    if (typeof host !== "string" || typeof user !== "string" || typeof agentId !== "string") {
      throw new Error(
        `IMAP account ${accountId} requires host, user, resolved password, and agentId`,
      );
    }
    if (typeof password !== "string") {
      if (asNonArrayRecord(password)) {
        onUnavailableAccount?.(accountId);
        continue;
      }
      throw new Error(`IMAP account ${accountId} requires a resolved password`);
    }
    const watch = asNonArrayRecord(account.watch);
    const senderAuth = asNonArrayRecord(account.senderAuth);
    const mode = watch?.mode;
    const min = senderAuth?.min;
    const thinking = [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "adaptive",
      "max",
      "ultra",
    ].find(
      (level): level is NonNullable<ImapAccountConfig["thinking"]> => level === account.thinking,
    );
    accounts[accountId] = {
      host,
      user,
      password,
      agentId,
      port: typeof account.port === "number" ? account.port : 993,
      secure: account.secure !== false,
      mailbox: typeof account.mailbox === "string" ? account.mailbox : "INBOX",
      watch: {
        mode: mode === "idle" || mode === "interval" ? mode : "auto",
        pollSeconds: Math.max(15, typeof watch?.pollSeconds === "number" ? watch.pollSeconds : 60),
      },
      allowedSenders: stringList(account.allowedSenders),
      senderAuth: {
        // The predicate requires every SDK strength to remain in the local config values.
        min:
          SENDER_STRENGTHS.find(
            (strength): strength is IdentifierAuthentication => strength === min,
          ) ?? "verified",
        trustedAuthservIds: stringList(senderAuth?.trustedAuthservIds),
        acceptTrustedAuthservId: senderAuth?.acceptTrustedAuthservId === true,
      },
      addressTokens: Array.isArray(account.addressTokens)
        ? account.addressTokens.flatMap((entry) => {
            const tokenEntry = asNonArrayRecord(entry);
            return typeof tokenEntry?.token === "string"
              ? [{ token: tokenEntry.token, senders: stringList(tokenEntry.senders) }]
              : [];
          })
        : [],
      deliver: account.deliver === true,
      includeBody: account.includeBody !== false,
      maxBytes: typeof account.maxBytes === "number" ? account.maxBytes : 20_000,
      ...(typeof account.model === "string" ? { model: account.model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(typeof account.timeoutSeconds === "number"
        ? { timeoutSeconds: account.timeoutSeconds }
        : {}),
    };
  }
  return { accounts };
}
