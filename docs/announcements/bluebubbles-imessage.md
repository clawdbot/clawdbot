---
summary: "BlueBubbles support was removed from OpenClaw. Use the bundled iMessage plugin with imsg for new and migrated iMessage setups."
read_when:
  - You used the old BlueBubbles channel and need to move to iMessage
  - You are choosing the supported OpenClaw iMessage setup
  - You need a short explanation of the BlueBubbles removal
title: "BlueBubbles removal and the imsg iMessage path"
---

# BlueBubbles removal and the imsg iMessage path

OpenClaw no longer ships the BlueBubbles channel. iMessage support now runs through the bundled `imessage` plugin, which starts [`imsg`](https://github.com/steipete/imsg) locally or through an SSH wrapper and talks JSON-RPC over stdin/stdout.

If your config still contains `channels.bluebubbles`, migrate it to `channels.imessage`. The legacy `/channels/bluebubbles` docs URL redirects to [Coming from BlueBubbles](/channels/imessage-from-bluebubbles), which has the full config translation table and cutover checklist.

## What changed

- There is no BlueBubbles HTTP server, webhook route, REST password, or BlueBubbles plugin runtime in the supported OpenClaw iMessage path.
- OpenClaw reads and watches Messages through `imsg` on the Mac where Messages.app is signed in.
- Basic send, receive, history, and media use the normal `imsg` surfaces and macOS permissions.
- Advanced actions such as threaded replies, tapbacks, edit, unsend, effects, read receipts, typing indicators, and group management require `imsg launch` with the private API bridge available.
- Linux and Windows gateways can still use iMessage by setting `channels.imessage.cliPath` to an SSH wrapper that runs `imsg` on the signed-in Mac.

## What to do

1. Install and verify `imsg` on the Messages Mac:

   ```bash
   brew install steipete/tap/imsg
   imsg --version
   imsg chats --limit 3
   imsg rpc --help
   ```

2. Grant Full Disk Access and Automation permissions to the process context that runs `imsg` and OpenClaw.

3. Translate the old config:

   ```json5
   {
     channels: {
       imessage: {
         enabled: true,
         cliPath: "/opt/homebrew/bin/imsg",
         dmPolicy: "pairing",
         allowFrom: ["+15555550123"],
         groupPolicy: "allowlist",
         groupAllowFrom: ["+15555550123"],
         groups: {
           "*": { requireMention: true },
         },
         includeAttachments: true,
       },
     },
   }
   ```

4. Restart the gateway and verify:

   ```bash
   openclaw channels status --probe
   ```

5. Test DMs, groups, attachments, and any private API actions you depend on before deleting your old BlueBubbles server.

## Migration notes

- `channels.bluebubbles.serverUrl` and `channels.bluebubbles.password` have no iMessage equivalent.
- `channels.bluebubbles.allowFrom`, `groupAllowFrom`, `groups`, `includeAttachments`, attachment roots, media size limits, chunking, and action toggles have iMessage equivalents.
- `channels.imessage.includeAttachments` is still off by default. Set it explicitly if you expect inbound photos, voice memos, videos, or files to reach the agent.
- With `groupPolicy: "allowlist"`, copy the old `groups` block, including any `"*"` wildcard entry. Group sender allowlists and the group registry are separate gates.
- ACP bindings that matched `channel: "bluebubbles"` must be changed to `channel: "imessage"`.
- Old BlueBubbles session keys do not become iMessage session keys. Pairing approvals carry over by handle, but conversation history under BlueBubbles session keys does not.

## See also

- [Coming from BlueBubbles](/channels/imessage-from-bluebubbles)
- [iMessage](/channels/imessage)
- [Configuration reference - iMessage](/gateway/config-channels#imessage)
