# Gateway Web App Completeness

Use this rubric when assigning category Completeness scores for the
`browser-control-ui-and-webchat` surface.

## Category Scope

- Browser Realtime Talk: Browser Talk start/stop, Provider session selection, Gateway relay audio, Tool-call consults, Steer and cancel
- Browser Access and Trust: Device pairing, Token/password auth, Tailscale Serve auth, Trusted proxy auth, Allowed origins/gatewayUrl
- Configuration: Config snapshots, Schema form editing, Raw JSON editing, Base-hash guarded writes, Apply and restart
- Browser UI: Gateway-hosted UI, Dashboard open/auth bootstrap, Base-path routing, Static asset recovery, Dev gatewayUrl target, PWA install metadata, Service worker updates, VAPID keys, Subscribe/unsubscribe, Test notifications
- WebChat Conversations: Send and abort, Session and agent picker, Model/thinking controls, Attachments, Markdown/tool/media rendering, chat.history projection, chat.send lifecycle, Abort/partial retention, Injected assistant notes, Reconnect continuity, Hosted embeds, External embed gating, Assistant media tickets, Authenticated avatars, CSP image policy
- Remote WebChat: macOS WebChat transport, SSH tunnel data plane, Direct ws/wss remote mode, Session continuity, Remote troubleshooting
- Operator Console: Health/status/models, Live log tail, Update run/status, Activity summaries, RPC timing telemetry, Channels/login, Session manager and history, Cron, Skills/nodes, Exec approvals/agents
