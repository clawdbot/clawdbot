# Telegram Maintainer Decisions

Use this page during Telegram PR review. These are intentional maintainer decisions, not incidental implementation details.

Verified against Telegram Bot API 10.0, May 8 2026.

## Streaming

- Do not reintroduce `sendMessageDraft` for answer streaming. Telegram drafts are ephemeral 30-second previews in private chats; final delivery still requires a separate `sendMessage`. OpenClaw uses `sendMessage` plus `editMessageText`, then finalizes in place so the user sees one persistent answer.
- Streaming owns one visible preview message. Edit it forward. Do not send an extra final bubble unless the final edit genuinely failed.
- Keep the first-preview debounce. If a provider sends token-sized deltas, coalesce them into cumulative preview text instead of removing the debounce.
- Respect Telegram limits in the Telegram layer. Text over 4096 chars chains into continuation messages. Polls keep the current Bot API 12-option cap.

## Telegram API Ownership

- Prefer grammY primitives and Telegram-native helpers when they model the behavior directly. Avoid custom Bot API wrappers for behavior grammY already owns.
- Throttling is bot-token scoped. All Telegram API clients for the same token share one grammY `apiThrottler()` instance.
- Do not silently retry failed topic sends without topic metadata. A wrong-surface success is worse than a loud Telegram error.
- DM topics and forum topics are distinct. `direct_messages_topic_id` and `message_thread_id` are not interchangeable.

## Context And Authorization

- Reply context comes from OpenClaw-observed messages. Bot API updates expose `reply_to_message`, but there is no arbitrary `getMessage(chat, id)` hydration path later.
- Current local chat context must outrank stale reply ancestry in the prompt. Old replied-to messages should not look like the active conversation.
- Pairing is DM-only. Group and topic authorization need explicit config allowlists.
- Telegram allowlists use numeric sender IDs. Usernames are optional, mutable, and not a reliable arbitrary-user lookup key in the Bot API.
- Group and channel visible replies are policy-controlled. Normal room replies stay private unless `messages.groupChat.visibleReplies: "automatic"` is set or the agent explicitly calls `message.send`.

## Interactive Surfaces

- Native callbacks stay structured. Approval, native command, plugin, select, and multiselect callbacks must not fall through as raw callback text.
- Preserve callback values exactly, including delimiters such as `env|prod`.
- Native slash commands should remain fast-pathable before full workspace and agent-turn setup.

## Review Standard

Telegram behavior PRs need real Telegram proof when they touch transport, streaming, topics, callbacks, authorization, or reply context. Prefer the bot-to-bot QA lane or an equivalent live Telegram probe over synthetic-only validation.
