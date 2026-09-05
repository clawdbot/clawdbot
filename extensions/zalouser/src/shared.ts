// Zalouser plugin module implements shared behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
  checkZcaAuthenticated,
  type ResolvedZalouserAccount,
} from "./accounts.js";
import { ZalouserConfigSchema } from "./config-schema.js";
import { zalouserDoctor } from "./doctor.js";

const zalouserMeta: ChannelPlugin<ResolvedZalouserAccount>["meta"] = {
  id: "zalouser",
  label: "Zalo Personal",
  selectionLabel: "Zalo (Personal Account)",
  docsPath: "/channels/zalouser",
  docsLabel: "zalouser",
  blurb: "Zalo personal account via QR code login.",
  aliases: ["zlu"],
  order: 85,
  quickstartAllowFrom: false,
};

const zalouserConfigAdapter = createScopedChannelConfigAdapter<ResolvedZalouserAccount>({
  sectionKey: "zalouser",
  listAccountIds: listZalouserAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveZalouserAccountSync),
  defaultAccountId: resolveDefaultZalouserAccountId,
  clearBaseFields: [
    "profile",
    "name",
    "dmPolicy",
    "allowFrom",
    "historyLimit",
    "mediaMaxMb",
    "groupAllowFrom",
    "groupPolicy",
    "groups",
    "messagePrefix",
  ],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(zalouser|zlu):/i }),
});

export function createZalouserPluginBase(params: {
  setupWizard: NonNullable<ChannelPlugin<ResolvedZalouserAccount>["setupWizard"]>;
  setupContract: NonNullable<ChannelPlugin<ResolvedZalouserAccount>["setupContract"]>;
}): Pick<
  ChannelPlugin<ResolvedZalouserAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "doctor"
  | "reload"
  | "configSchema"
  | "config"
  | "setupContract"
> {
  return {
    id: "zalouser",
    meta: zalouserMeta,
    setupWizard: params.setupWizard,
    capabilities: {
      chatTypes: ["direct", "group"],
      media: true,
      reactions: true,
      threads: false,
      polls: false,
      nativeCommands: false,
      blockStreaming: true,
    },
    doctor: zalouserDoctor,
    reload: { configPrefixes: ["channels.zalouser"] },
    configSchema: buildChannelConfigSchema(ZalouserConfigSchema),
    config: {
      ...zalouserConfigAdapter,
      isConfigured: (account) => Boolean(account.profile),
      isLinked: async (account) =>
        (await checkZcaAuthenticated(account.profile)) ? "linked" : "not-linked",
      unconfiguredReason: () => "not configured",
      unlinkedReason: () => "not authenticated",
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: Boolean(account.profile),
        }),
    },
    setupContract: params.setupContract,
  };
}
