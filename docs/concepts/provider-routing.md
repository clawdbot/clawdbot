---
summary: "Routing rules per provider (WhatsApp, Telegram, Discord, Matrix, web) and shared context"
read_when:
  - Changing provider routing or inbox behavior
---
# Providers & Routing

Updated: 2026-01-06

Goal: deterministic replies per provider, while supporting multi-agent + multi-account routing.

- **Provider**: provider label (`whatsapp`, `webchat`, `telegram`, `discord`, `signal`, `imessage`, `matrix`, …). Routing is fixed: replies go back to the origin provider; the model doesn’t choose.
- **AccountId**: provider account instance (e.g. WhatsApp account `"default"` vs `"work"`). Not every provider supports multi-account yet.
- **AgentId**: one isolated “brain” (workspace + per-agent agentDir + per-agent session store).
- **Reply context:** inbound replies include `ReplyToId`, `ReplyToBody`, and `ReplyToSender`, and the quoted context is appended to `Body` as a `[Replying to ...]` block.
- **Canonical direct session (per agent):** direct chats collapse to `agent:<agentId>:<mainKey>` (default `main`). Groups/channels stay isolated per agent:
  - group: `agent:<agentId>:<provider>:group:<id>`
  - channel/room: `agent:<agentId>:<provider>:channel:<id>`
  - Telegram forum topics: `agent:<agentId>:telegram:group:<chatId>:topic:<threadId>`
- **Session store:** per-agent store lives under `~/.clawdbot/agents/<agentId>/sessions/sessions.json` (override via `session.store` with `{agentId}` templating). JSONL transcripts live next to it.
- **WebChat:** attaches to the selected agent’s main session (so desktop reflects cross-provider history for that agent).
- **Implementation hints:**
  - Set `Provider` + `AccountId` in each ingress.
  - Route inbound to an agent via `routing.bindings` (match on `provider`, `accountId`, plus optional peer/guild/team).
  - Keep routing deterministic: originate → same provider. Use the gateway WebSocket for sends; avoid side channels.
  - Do not let the agent emit “send to X” decisions; keep that policy in the host code.
