---
summary: "Slack setup and runtime behavior (Socket Mode, HTTP Request URLs, and relay mode)"
read_when:
  - Setting up Slack or debugging Slack socket, HTTP, or relay mode
title: "Slack"
---

Slack support covers DMs and channels via Slack app integrations. Default transport is Socket Mode; HTTP Request URLs are also supported. Relay mode is for managed deployments where a trusted router owns Slack ingress.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Slack DMs default to pairing mode.
  </Card>
  <Card title="Slash commands" icon="terminal" href="/tools/slash-commands">
    Native command behavior and command catalog.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel diagnostics and repair playbooks.
  </Card>
</CardGroup>

## What each page covers

- [Slack setup](/channels/slack/setup) — install the plugin, create the Slack app, and configure tokens.
- [Slack transports](/channels/slack/transports) — Socket Mode, HTTP Request URLs, and relay mode compared.
- [Slack Enterprise Grid](/channels/slack/enterprise-grid) — org-wide installs across a Grid organization.
- [Slack manifest and scopes](/channels/slack/manifest-and-scopes) — the base app manifest, OAuth scopes, and optional settings.
- [Slack access control](/channels/slack/access-control) — DM policy, channel allowlists, mention gating, and action gates.
- [Slack threads and sessions](/channels/slack/threads-and-sessions) — session keys, reply threading, and Agent View DMs.
- [Slack message behavior](/channels/slack/messaging) — ack reactions, streaming previews, and slash commands.
- [Slack media and attachments](/channels/slack/media) — audio clips, inbound files, chunking, and delivery targets.
- [Slack charts, tables, and approvals](/channels/slack/rich-messages) — native charts, tables, modals, and approval buttons.
- [Slack events and operations](/channels/slack/events) — system events, interactions, and presence polling.
- [Slack troubleshooting](/channels/slack/troubleshooting) — silent channels, ignored DMs, and dead transports.

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here, so an existing link such as `/channels/slack#text-streaming` still resolves. Each entry points at the page that now holds the content.

- <a id="choosing-a-transport" />[Choosing a transport](/channels/slack/transports#choosing-a-transport)
- <a id="relay-mode" />[Relay mode](/channels/slack/transports#relay-mode)
- <a id="enterprise-grid-org-wide-installs" />[Enterprise Grid org-wide installs](/channels/slack/enterprise-grid#enterprise-grid-org-wide-installs)
- <a id="socket-mode" />[Socket Mode](/channels/slack/enterprise-grid#socket-mode)
- <a id="http-request-urls" />[HTTP Request URLs](/channels/slack/enterprise-grid#http-request-urls)
- <a id="install" />[Install](/channels/slack/setup#install)
- <a id="quick-setup" />[Quick setup](/channels/slack/setup#quick-setup)
- <a id="user-identity-(post-as-a-real-person)" />[User identity (post as a real person)](</channels/slack/setup#user-identity-(post-as-a-real-person)>)
- <a id="socket-mode-transport-tuning" />[Socket Mode transport tuning](/channels/slack/transports#socket-mode-transport-tuning)
- <a id="manifest-and-scope-checklist" />[Manifest and scope checklist](/channels/slack/manifest-and-scopes#manifest-and-scope-checklist)
- <a id="additional-manifest-settings" />[Additional manifest settings](/channels/slack/manifest-and-scopes#additional-manifest-settings)
- <a id="token-model" />[Token model](/channels/slack/setup#token-model)
- <a id="actions-and-gates" />[Actions and gates](/channels/slack/access-control#actions-and-gates)
- <a id="access-control-and-routing" />[Access control and routing](/channels/slack/access-control#access-control-and-routing)
- <a id="group-dms-(mpdms)-and-bots" />[Group DMs (MPDMs) and bots](</channels/slack/access-control#group-dms-(mpdms)-and-bots>)
- <a id="threading%2C-sessions%2C-and-reply-tags" />[Threading, sessions, and reply tags](/channels/slack/threads-and-sessions#threading%2C-sessions%2C-and-reply-tags)
- <a id="agent-view-dms" />[Agent View DMs](/channels/slack/threads-and-sessions#agent-view-dms)
- <a id="ack-reactions" />[Ack reactions](/channels/slack/messaging#ack-reactions)
- <a id="emoji-(ackreaction)" />[Emoji (ackReaction)](</channels/slack/messaging#emoji-(ackreaction)>)
- <a id="scope-(messages.ackreactionscope)" />[Scope (messages.ackReactionScope)](</channels/slack/messaging#scope-(messages.ackreactionscope)>)
- <a id="text-streaming" />[Text streaming](/channels/slack/messaging#text-streaming)
- <a id="typing-reaction-fallback" />[Typing reaction fallback](/channels/slack/messaging#typing-reaction-fallback)
- <a id="voice-input" />[Voice input](/channels/slack/media#voice-input)
- <a id="media%2C-chunking%2C-and-delivery" />[Media, chunking, and delivery](/channels/slack/media#media%2C-chunking%2C-and-delivery)
- <a id="commands-and-slash-behavior" />[Commands and slash behavior](/channels/slack/messaging#commands-and-slash-behavior)
- <a id="native-charts" />[Native charts](/channels/slack/rich-messages#native-charts)
- <a id="native-tables" />[Native tables](/channels/slack/rich-messages#native-tables)
- <a id="plugin-owned-modal-submissions" />[Plugin-owned modal submissions](/channels/slack/rich-messages#plugin-owned-modal-submissions)
- <a id="native-approvals-in-slack" />[Native approvals in Slack](/channels/slack/rich-messages#native-approvals-in-slack)
- <a id="events-and-operational-behavior" />[Events and operational behavior](/channels/slack/events#events-and-operational-behavior)
- <a id="presence-events" />[Presence events](/channels/slack/events#presence-events)
- <a id="troubleshooting" />[Troubleshooting](/channels/slack/troubleshooting#troubleshooting)
- <a id="attachment-media-reference" />[Attachment media reference](/channels/slack/media#attachment-media-reference)
- <a id="supported-media-types" />[Supported media types](/channels/slack/media#supported-media-types)
- <a id="inbound-pipeline" />[Inbound pipeline](/channels/slack/media#inbound-pipeline)
- <a id="thread-root-attachment-inheritance" />[Thread-root attachment inheritance](/channels/slack/media#thread-root-attachment-inheritance)
- <a id="multi-attachment-handling" />[Multi-attachment handling](/channels/slack/media#multi-attachment-handling)
- <a id="size%2C-download%2C-and-model-limits" />[Size, download, and model limits](/channels/slack/media#size%2C-download%2C-and-model-limits)
- <a id="known-limits" />[Known limits](/channels/slack/media#known-limits)
- <a id="related-documentation" />[Related documentation](/channels/slack/media#related-documentation)
- <a id="user-identity-post-as-a-real-person" />[User identity (post as a real person)](/channels/slack/setup#user-identity-post-as-a-real-person)
- <a id="group-dms-mpdms-and-bots" />[Group DMs (MPDMs) and bots](/channels/slack/access-control#group-dms-mpdms-and-bots)
- <a id="threading-sessions-and-reply-tags" />[Threading, sessions, and reply tags](/channels/slack/threads-and-sessions#threading-sessions-and-reply-tags)
- <a id="emoji-ackreaction" />[Emoji (ackReaction)](/channels/slack/messaging#emoji-ackreaction)
- <a id="scope-messages-ackreactionscope" />[Scope (messages.ackReactionScope)](/channels/slack/messaging#scope-messages-ackreactionscope)
- <a id="media-chunking-and-delivery" />[Media, chunking, and delivery](/channels/slack/media#media-chunking-and-delivery)
- <a id="size-download-and-model-limits" />[Size, download, and model limits](/channels/slack/media#size-download-and-model-limits)
- <a id="socket-mode-default" />[Socket Mode (default)](/channels/slack/setup#socket-mode-default)
- <a id="create-a-new-slack-app" />[Create a new Slack app](/channels/slack/setup#create-a-new-slack-app)
- <a id="configure-openclaw" />[Configure OpenClaw](/channels/slack/setup#configure-openclaw)
- <a id="start-gateway" />[Start gateway](/channels/slack/setup#start-gateway)
- <a id="http-request-urls-1" />[HTTP Request URLs](/channels/slack/setup#http-request-urls)
- <a id="create-a-new-slack-app-1" />[Create a new Slack app](/channels/slack/setup#create-a-new-slack-app-1)
- <a id="configure-openclaw-1" />[Configure OpenClaw](/channels/slack/setup#configure-openclaw-1)
- <a id="start-gateway-1" />[Start gateway](/channels/slack/setup#start-gateway-1)
- <a id="optional-native-slash-commands" />[Optional native slash commands](/channels/slack/manifest-and-scopes#optional-native-slash-commands)
- <a id="socket-mode-default-2" />[Socket Mode (default)](/channels/slack/manifest-and-scopes#socket-mode-default)
- <a id="http-request-urls-2" />[HTTP Request URLs](/channels/slack/manifest-and-scopes#http-request-urls)
- <a id="optional-authorship-scopes-write-operations" />[Optional authorship scopes (write operations)](/channels/slack/manifest-and-scopes#optional-authorship-scopes-write-operations)
- <a id="optional-user-token-scopes-read-operations" />[Optional user-token scopes (read operations)](/channels/slack/manifest-and-scopes#optional-user-token-scopes-read-operations)
- <a id="dm-policy" />[DM policy](/channels/slack/access-control#dm-policy)
- <a id="channel-policy" />[Channel policy](/channels/slack/access-control#channel-policy)
- <a id="mentions-and-channel-users" />[Mentions and channel users](/channels/slack/access-control#mentions-and-channel-users)
- <a id="inbound-attachments" />[Inbound attachments](/channels/slack/media#inbound-attachments)
- <a id="outbound-text-and-files" />[Outbound text and files](/channels/slack/media#outbound-text-and-files)
- <a id="delivery-targets" />[Delivery targets](/channels/slack/media#delivery-targets)
- <a id="no-replies-in-channels" />[No replies in channels](/channels/slack/troubleshooting#no-replies-in-channels)
- <a id="dm-messages-ignored" />[DM messages ignored](/channels/slack/troubleshooting#dm-messages-ignored)
- <a id="agent-view-dms-share-one-session" />[Agent View DMs share one session](/channels/slack/troubleshooting#agent-view-dms-share-one-session)
- <a id="socket-mode-not-connecting" />[Socket mode not connecting](/channels/slack/troubleshooting#socket-mode-not-connecting)
- <a id="http-mode-not-receiving-events" />[HTTP mode not receiving events](/channels/slack/troubleshooting#http-mode-not-receiving-events)
- <a id="native-slash-commands-not-firing" />[Native/slash commands not firing](/channels/slack/troubleshooting#native-slash-commands-not-firing)

## Configuration reference

Primary reference: [Configuration reference - Slack](/gateway/config-channels#slack).

<Accordion title="High-signal Slack fields">

- mode/auth: `postAs`, `mode`, `botToken`, `appToken`, `userToken`, `signingSecret`, `webhookPath`, `accounts.*`
- DM access: `dm.enabled`, `dmPolicy`, `allowFrom` (legacy: `dm.policy`, `dm.allowFrom`), `dm.groupEnabled`, `dm.groupChannels`
- compatibility toggle: `dangerouslyAllowNameMatching` (break-glass; keep off unless needed)
- channel access: `groupPolicy`, `channels.*`, `channels.*.users`, `channels.*.requireMention`, `implicitMentions.*`
- group introductions: `joinIntro`, `accounts.*.joinIntro` (default: `true`)
- threading/history: `replyToMode`, `replyToModeByChatType`, `thread.*`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- presence wakes: `presenceEvents.mode`, `presenceEvents.prompt`, `channels.*.presenceEvents.*` (`off|auto|on`; default `off`)
- delivery: `textChunkLimit`, `streaming.chunkMode`, `mediaMaxMb`, `streaming`, `streaming.nativeTransport`, `streaming.preview.toolProgress`
- unfurls: `unfurlLinks` (default: `false`), `unfurlMedia` for `chat.postMessage` link/media preview control; set `unfurlLinks: true` to opt back into link previews
- ops/features: `configWrites`, `commands.native`, `slashCommand.*`, `actions.*`, `userToken`, `userTokenReadOnly`

</Accordion>

## Related

<CardGroup cols={2}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Pair a Slack user to the gateway.
  </Card>
  <Card title="Groups" icon="users" href="/channels/groups">
    Channel and group DM behavior.
  </Card>
  <Card title="Channel routing" icon="route" href="/channels/channel-routing">
    Route inbound messages to agents.
  </Card>
  <Card title="Security" icon="shield" href="/gateway/security">
    Threat model and hardening.
  </Card>
  <Card title="Configuration" icon="sliders" href="/gateway/configuration">
    Config layout and precedence.
  </Card>
  <Card title="Slash commands" icon="terminal" href="/tools/slash-commands">
    Command catalog and behavior.
  </Card>
</CardGroup>
