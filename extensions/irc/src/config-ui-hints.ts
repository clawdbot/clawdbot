import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
// Irc helper module supports config ui hints behavior.
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const ircChannelConfigUiHints = {
  "": {
    label: "IRC",
    help: "IRC channel provider configuration and compatibility settings for classic IRC transport workflows. Use this section when bridging legacy chat infrastructure into OpenClaw.",
  },
  ...createChannelConfigUiHints({ channelLabel: "IRC", dmPolicy: { channelKey: "irc" } }),
  "nickserv.enabled": {
    label: "IRC NickServ Enabled",
    help: "Enable NickServ identify/register after connect (defaults to enabled when password is configured).",
  },
  "nickserv.service": {
    label: "IRC NickServ Service",
    help: "NickServ service nick (default: NickServ).",
  },
  "nickserv.password": {
    label: "IRC NickServ Password",
    help: "NickServ password used for IDENTIFY/REGISTER (sensitive).",
  },
  "nickserv.passwordFile": {
    label: "IRC NickServ Password File",
    help: "Optional file path containing NickServ password.",
  },
  "nickserv.register": {
    label: "IRC NickServ Register",
    help: "If true, send NickServ REGISTER on every connect. Use once for initial registration, then disable.",
  },
  "nickserv.registerEmail": {
    label: "IRC NickServ Register Email",
    help: "Email used with NickServ REGISTER (required when register=true).",
  },
  ...createChannelConfigUiHints({ channelLabel: "IRC", configWrites: true }),
} satisfies Record<string, ChannelConfigUiHint>;
