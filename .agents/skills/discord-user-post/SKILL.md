---
name: discord-user-post
description: Post an approved message as the logged-in Discord user through the Discord desktop app. Use for release announcements or other direct user-authored Discord posts; not for OpenClaw channel sends, bots, webhooks, relays, agent sessions, or archive search.
---

# Discord User Post

Use `$computer-use` to operate `/Applications/Discord.app` in the user's
existing logged-in session. This workflow represents the user directly.

## Prepare

1. Draft the complete final message outside Discord.
2. Confirm the intended server and channel with the user when either is
   ambiguous.
3. Open Discord and navigate to the exact destination without entering the
   message.
4. Verify the visible server name, channel header, and logged-in account.

Do not infer the target from unrelated Discord content. Stop if Discord is not
logged in, the account is wrong, or the exact destination cannot be verified.

## Confirm and Post

Posting is representational communication. Follow the `$computer-use`
confirmation policy even when the user previously asked for an announcement:

1. Show the user the exact final body and verified destination.
2. Request action-time confirmation before typing into Discord.
3. After confirmation, enter the approved body unchanged.
4. Visually inspect the composed message and destination again.
5. Send once.

If the body or destination changes after confirmation, request confirmation
again before sending.

## Verify

- Confirm the message appears once, from the user's account, in the intended
  channel.
- Report the server, channel, and visible send result.
- Do not edit, delete, react, or send a follow-up without the corresponding
  user instruction and confirmation.

## Guardrails

- Never use `openclaw message`, an OpenClaw agent, a Discord bot, webhook, relay,
  or token for this workflow.
- Never expose private Discord content or account details in public output.
- Never send a draft, partial message, duplicate, or unreviewed attachment.
- For Discord archive/history/search, use `$discrawl` instead.
