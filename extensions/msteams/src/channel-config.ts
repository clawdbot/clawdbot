import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import { createTopLevelChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import { resolveMSTeamsCredentials } from "./token.js";

export type ResolvedMSTeamsAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  tokenStatus: "available" | "configured_unavailable" | "missing";
  credentialDiagnostics?: Extract<
    ReturnType<typeof tryReadSecretFileSync>,
    { status: "configured_unavailable" }
  >["diagnostic"][];
};

export const msteamsMeta = {
  id: "msteams",
  label: "Microsoft Teams",
  selectionLabel: "Microsoft Teams (Bot Framework)",
  docsPath: "/channels/msteams",
  docsLabel: "msteams",
  blurb: "Teams SDK; enterprise support.",
  aliases: ["teams"],
  order: 60,
} as const;

export function resolveMSTeamsAccount(cfg: OpenClawConfig): ResolvedMSTeamsAccount {
  const config = cfg.channels?.msteams;
  const credentials = resolveMSTeamsCredentials(config);
  const certificatePath =
    credentials?.type === "federated" && !credentials.useManagedIdentity
      ? credentials.certificatePath
      : undefined;
  const certificate = certificatePath
    ? tryReadSecretFileSync(certificatePath, "Microsoft Teams certificate", undefined, {
        configPath: config?.certificatePath?.trim()
          ? "channels.msteams.certificatePath"
          : "env.MSTEAMS_CERTIFICATE_PATH",
      })
    : undefined;
  const unavailable = certificate?.status === "configured_unavailable";
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: config?.enabled !== false,
    configured: Boolean(credentials),
    tokenStatus: !credentials ? "missing" : unavailable ? "configured_unavailable" : "available",
    ...(unavailable ? { credentialDiagnostics: [certificate.diagnostic] } : {}),
  };
}

export const msteamsConfigAdapter = createTopLevelChannelConfigAdapter<
  ResolvedMSTeamsAccount,
  {
    allowFrom?: Array<string | number>;
    defaultTo?: string;
  }
>({
  sectionKey: "msteams",
  resolveAccount: resolveMSTeamsAccount,
  resolveAccessorAccount: ({ cfg }) => ({
    allowFrom: cfg.channels?.msteams?.allowFrom,
    defaultTo: cfg.channels?.msteams?.defaultTo,
  }),
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account) => account.defaultTo,
});
