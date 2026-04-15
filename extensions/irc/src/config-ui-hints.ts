import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const ircChannelConfigUiHints = {
  "": {
    label: "IRC",
    help: "IRC channel provider configuration and compatibility settings for classic IRC transport workflows. Use this section when bridging legacy chat infrastructure into OpenClaw.",
  },
  dmPolicy: {
    label: "IRC DM Policy",
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.irc.allowFrom=["*"].',
  },
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
  configWrites: {
    label: "IRC Config Writes",
    help: "Allow IRC to write config in response to channel events/commands (default: true).",
  },
} satisfies Record<string, ChannelConfigUiHint>;
