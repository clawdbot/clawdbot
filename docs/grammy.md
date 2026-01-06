---
summary: "Telegram Bot API integration via grammY with setup notes"
read_when:
  - Working on Telegram or grammY pathways
---
# grammY Integration (Telegram Bot API)

Updated: 2025-12-07

# Why grammY
- TS-first Bot API client with built-in long-poll + webhook helpers, middleware, error handling, rate limiter.
- Cleaner media helpers than hand-rolling fetch + FormData; supports all Bot API methods.
- Extensible: proxy support via custom fetch, session middleware (optional), type-safe context.

# What we shipped
- **Single client path:** fetch-based implementation removed; grammY is now the sole Telegram client (send + gateway) with the grammY throttler enabled by default.
- **Gateway:** `monitorTelegramProvider` builds a grammY `Bot`, wires mention/allowlist gating, media download via `getFile`/`download`, and delivers replies with `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Supports long-poll or webhook via `webhookCallback`.
- **Proxy:** optional `telegram.proxy` uses `undici.ProxyAgent` through grammY’s `client.baseFetch`.
- **Webhook support:** `webhook-set.ts` wraps `setWebhook/deleteWebhook`; `webhook.ts` hosts the callback with health + graceful shutdown. Gateway enables webhook mode when `telegram.webhookUrl` is set (otherwise it long-polls).
- **Sessions:** direct chats map to `main`; groups map to `telegram:group:<chatId>`; replies route back to the same surface.
- **Config knobs:** `telegram.botToken`, `telegram.dmPolicy`, `telegram.groups` (allowlist + mention defaults), `telegram.allowFrom`, `telegram.groupAllowFrom`, `telegram.groupPolicy`, `telegram.mediaMaxMb`, `telegram.proxy`, `telegram.webhookSecret`, `telegram.webhookUrl`.
- **Tests:** grammy mocks cover DM + group mention gating and outbound send; more media/webhook fixtures still welcome.

Open questions
- Optional grammY plugins (throttler) if we hit Bot API 429s.
- Add more structured media tests (stickers, voice notes).
- Make webhook listen port configurable (currently fixed to 8787 unless wired through the gateway).
