import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";

const ShipSchema = z.string().min(1);
const ChannelNestSchema = z.string().min(1);

const TlonChannelRuleSchema = z.object({
  mode: z.enum(["restricted", "open"]).optional(),
  allowedShips: z.array(ShipSchema).optional(),
});

export const TlonAuthorizationSchema = z.object({
  channelRules: z.record(z.string(), TlonChannelRuleSchema).optional(),
});

const TlonNetworkSchema = z
  .object({
    dangerouslyAllowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .optional();

const tlonCommonConfigFields = {
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  ship: ShipSchema.optional(),
  url: z.string().optional(),
  code: z.string().optional(),
  network: TlonNetworkSchema,
  groupChannels: z.array(ChannelNestSchema).optional(),
  dmAllowlist: z.array(ShipSchema).optional(),
  groupInviteAllowlist: z.array(ShipSchema).optional(),
  autoDiscoverChannels: z.boolean().optional(),
  showModelSignature: z.boolean().optional(),
  responsePrefix: z.string().optional(),
  // Auto-accept settings
  autoAcceptDmInvites: z.boolean().optional(), // Auto-accept DMs from ships in dmAllowlist
  autoAcceptGroupInvites: z.boolean().optional(), // Auto-accept all group invites
  // Owner ship for approval system
  ownerShip: ShipSchema.optional(), // Ship that receives approval requests and can approve/deny
} satisfies z.ZodRawShape;

const TlonAccountSchema = z.object({
  ...tlonCommonConfigFields,
});

export const TlonConfigSchema = z.object({
  ...tlonCommonConfigFields,
  authorization: TlonAuthorizationSchema.optional(),
  defaultAuthorizedShips: z.array(ShipSchema).optional(),
  accounts: z.record(z.string(), TlonAccountSchema).optional(),
});

export const tlonChannelConfigSchema = buildChannelConfigSchema(TlonConfigSchema);
