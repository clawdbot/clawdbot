// Irc helper module supports config schema behavior.
import {
  ChannelGroupEntrySchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  buildChannelConfigSchema,
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

const IrcAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
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
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z.record(z.string(), ChannelGroupEntrySchema.optional()).optional(),
    channels: z.array(z.string()).optional(),
    mentionPatterns: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    ...ReplyRuntimeConfigSchemaShape,
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
