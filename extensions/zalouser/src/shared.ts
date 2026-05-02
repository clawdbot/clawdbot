import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
  checkZcaAuthenticated,
  type ResolvedZalouserAccount,
} from "./accounts.js";
import type { ChannelPlugin } from "./channel-api.js";
import { buildChannelConfigSchema, formatAllowFromLowercase } from "./channel-api.js";
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
  setup: NonNullable<ChannelPlugin<ResolvedZalouserAccount>["setup"]>;
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
  | "setup"
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
      isConfigured: async (account) => await checkZcaAuthenticated(account.profile),
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
        }),
    },
    setup: params.setup,
  };
}
