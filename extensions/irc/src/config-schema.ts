// Irc helper module supports config schema behavior.
import {
  ChannelGroupEntrySchema,
  buildChannelConfigSchema,
  buildCommonChannelAccountShape,
  buildMultiAccountChannelSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";
import { ircChannelConfigUiHints } from "./config-ui-hints.js";

const IrcNickServSchema = z
  .object({
    enabled: z.boolean().optional(),
    service: z.string().optional(),
    password: z.string().optional(),
    passwordFile: z.string().optional(),
    register: z.boolean().optional(),
    registerEmail: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.register && !value.registerEmail?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["registerEmail"],
        message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail",
      });
    }
  });

const IrcCommonAccountShape = buildCommonChannelAccountShape({
  useDefaults: true,
  omit: [
    "capabilities",
    "defaultTo",
    "mentionPatterns",
    "heartbeatVisibility",
    "healthMonitor",
    "replyToMode",
  ],
});

const IrcAccountSchemaBase = z
  .object({
    name: IrcCommonAccountShape.name,
    enabled: IrcCommonAccountShape.enabled,
    configWrites: IrcCommonAccountShape.configWrites,
    dangerouslyAllowNameMatching: z.boolean().optional(),
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    tls: z.boolean().optional(),
    nick: z.string().optional(),
    username: z.string().optional(),
    realname: z.string().optional(),
    password: z.string().optional(),
    passwordFile: z.string().optional(),
    nickserv: IrcNickServSchema.optional(),
    dmPolicy: IrcCommonAccountShape.dmPolicy,
    allowFrom: IrcCommonAccountShape.allowFrom,
    groupPolicy: IrcCommonAccountShape.groupPolicy,
    groupAllowFrom: IrcCommonAccountShape.groupAllowFrom,
    groups: z.record(z.string(), ChannelGroupEntrySchema.optional()).optional(),
    channels: z.array(z.string()).optional(),
    mentionPatterns: z.array(z.string()).optional(),
    markdown: IrcCommonAccountShape.markdown,
    historyLimit: IrcCommonAccountShape.historyLimit,
    dmHistoryLimit: IrcCommonAccountShape.dmHistoryLimit,
    contextVisibility: IrcCommonAccountShape.contextVisibility,
    dms: IrcCommonAccountShape.dms,
    textChunkLimit: IrcCommonAccountShape.textChunkLimit,
    streaming: IrcCommonAccountShape.streaming,
    responsePrefix: IrcCommonAccountShape.responsePrefix,
    mediaMaxMb: IrcCommonAccountShape.mediaMaxMb,
  })
  .strict();

const IrcConfigSchema = buildMultiAccountChannelSchema(IrcAccountSchemaBase, {
  optionalAccount: true,
  refine: (value, ctx) => {
    requireOpenAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message: 'channels.irc.dmPolicy="open" requires channels.irc.allowFrom to include "*"',
    });
  },
});

export const IrcChannelConfigSchema = buildChannelConfigSchema(IrcConfigSchema, {
  uiHints: ircChannelConfigUiHints,
});
