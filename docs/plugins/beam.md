---
summary: "Publish redacted coding sessions for shared viewing and independent Team continuation"
read_when:
  - Sharing a Claude Code or Codex session with trusted Gateway operators
  - Continuing a beamed conversation with a Team agent
  - Configuring an authenticated session-ingest endpoint without connecting a node
  - Auditing what Beam stores and exposes
title: "Beam plugin"
---

The bundled `beam` plugin receives a sanitized coding-session snapshot over authenticated HTTP and presents it in the Control UI's existing external-session catalog. The source computer sends text out; OpenClaw never connects back to that computer and receives no filesystem, terminal, tool, or node capability.

Beam ships with OpenClaw but is disabled by default. When enabled, it registers:

- `POST /api/v1/beam/sessions`
- the **Beam** session catalog in the Control UI sidebar

## Enable

```bash
openclaw plugins enable beam
openclaw gateway restart
```

Equivalent config:

```json5
{
  plugins: {
    entries: {
      beam: { enabled: true },
    },
  },
}
```

Disable the plugin when the ingest route is not needed:

```bash
openclaw plugins disable beam
openclaw gateway restart
```

## Authentication

The receiver uses normal Gateway HTTP authentication. It is not an anonymous upload endpoint.

- With `gateway.auth.mode: "trusted-proxy"`, send requests through the configured identity-aware proxy. Beam records the verified uploader's OpenClaw profile ID, when available; it does not retain proxy identity headers or credentials.
- With token or password auth, send `Authorization: Bearer <gateway-token-or-password>`.
- Do not enable Beam with `gateway.auth.mode: "none"` unless another private ingress fully authenticates every request.

A Cloudflare Access-protected deployment can authenticate a local CLI without exposing a GitHub token:

```bash
cloudflared access login https://gateway.example.com
cloudflared access curl https://gateway.example.com/api/v1/beam/sessions \
  -H 'Content-Type: application/json' \
  --data-binary @sanitized-beam.json
```

The `beam` skill in [openclaw/agent-skills](https://github.com/openclaw/agent-skills) handles local transcript discovery, redaction, Cloudflare Access login, and upload for Claude Code and Codex.

## Request

```http
POST /api/v1/beam/sessions
Content-Type: application/json
```

```json
{
  "version": 1,
  "beamId": "0123456789abcdef0123456789abcdef",
  "source": "claude",
  "sourceModel": { "provider": "anthropic", "model": "claude-opus-4-1" },
  "title": "Fix the upload flow",
  "updatedAt": "2026-07-20T12:00:00.000Z",
  "completed": false,
  "items": [
    { "type": "userMessage", "text": "Fix the upload flow." },
    { "type": "agentMessage", "text": "Implemented and tested." },
    { "type": "other", "text": "3 read, 2 write, 1 execute; raw tool outputs dropped: 4" }
  ]
}
```

Send `items` in conversation order, oldest first. Beam preserves that order in storage and displays questions before their replies. Its session-catalog API returns newest-first pages, matching the other coding-session catalogs.

The schema is closed. Beam rejects unknown fields, invalid item types, empty text, more than 200 items, item text over 6,000 characters, non-JSON requests, and bodies over 56 KiB.

A successful upload returns the stable Beam id and a relative Control UI URL:

```json
{
  "ok": true,
  "beamId": "0123456789abcdef0123456789abcdef",
  "url": "/beam/fix-the-upload-flow-0123456789ab"
}
```

The returned URL uses the session title slug followed by a 12-character lowercase
hexadecimal id prefix, matching regular session links. The id remains authoritative:
bare-id links and links with an older title still resolve, and the browser replaces
the name with the current title without adding history. Titles that produce no slug
use the bare id. A configured Control UI base path prefixes the route, for example
`/openclaw/beam/fix-the-upload-flow-0123456789ab`. Longer prefixes through the full
32-character Beam id also work. Update the Beam skill before updating the receiver
so its response validator accepts named links.

Uploading the same `beamId` updates the existing catalog row. A completed upload sets the row status to `completed`; earlier updates display as `live`.

`sourceModel` is optional. Current automatic mirrors include the latest model reported by the source catalog. Older clients and snapshots remain valid without it.

## Continue on the Team Gateway

Select a Beam in the Control UI and write a message in its composer. On the first send, OpenClaw creates a normal session for the selected Team agent, copies the bounded sanitized Beam history into it, and sends your message there. The original Beam stays unchanged, and later source uploads do not alter the copied session.

OpenClaw uses `sourceModel` when that exact model is available to the Team agent. Otherwise it uses the agent's configured model. Each copied transcript item is marked as untrusted external content. The copied session also includes a notice that the old content is reference material rather than operator instructions, names the model choice, and explains that the session cannot access the source machine or its tools.

Continuation is a copy, not remote resume or two-way synchronization. Each operator may create an independent continuation from the same Beam.

## Storage and visibility

Beam stores sanitized payloads in OpenClaw's shared SQLite-backed plugin state:

- at most 500 sessions
- seven-day retention refreshed by each update
- oldest-entry eviction when the catalog reaches its bound
- server receipt time controls catalog ordering; clients cannot move themselves ahead with a forged timestamp

The catalog is intentionally shared across the Gateway operator domain. Every client with `operator.read` can view every beamed session. Uploading or continuing requires `operator.write` or `operator.admin`; agent access policy must also allow the chosen agent. Any write-authorized operator that knows a Beam id can update that row. Uploader attribution does not grant ownership or change access. OpenClaw operator scopes are not tenant isolation; use a separate Gateway when sessions must be isolated between teams or machines.

A continuation belongs to the authenticated operator who creates it. From then on it follows ordinary session sharing, sandbox, tool, and model policy for that Team agent. Access to the original Beam does not grant access to another operator's continuation.

User turns are attributed to the verified publisher of the current snapshot, using their current profile name and avatar, including merged profiles. Beam's upload format does not identify individual authors within a multi-user transcript. The uploader reference shares the snapshot's seven-day retention and is replaced on each upload. Shared-token uploads, failed profile resolution, and older snapshots without a recorded uploader display **User**; they never inherit the viewer's identity or a previous uploader's identity. Reupload an older snapshot through personal authentication to attribute it.

## Security boundary

Beam publication is not remote control.

- Continuing makes an independent Gateway-owned session. Beam itself has no archive, terminal, tool, or node capability.
- It accepts text-only normalized transcript items, not HTML, scripts, archives, attachments, or server-fetched URLs.
- The official skill removes raw tool results, reasoning, prompts, local paths, credentials, cookies, and auth material before upload.
- The receiver treats every transcript as untrusted text. The first message in the Beam composer is the explicit operator action that copies it into a new session.
- Requests are rate-limited and concurrency-limited before the body is read.

## Mirroring

Beam can also act as the sender: an opt-in mirror that continuously publishes this machine's active local coding sessions (Claude Code, Codex, and other registered session catalogs) to a remote Beam receiver, such as a shared team Gateway. Teammates then watch near-live session transcripts in the remote Control UI without any access to the source machine.

```json5
{
  plugins: {
    entries: {
      beam: {
        enabled: true,
        config: {
          mirror: {
            endpoint: "https://team.example.com/api/v1/beam/sessions",
            token: { source: "env", provider: "default", id: "BEAM_TEAM_TOKEN" },
            catalogs: ["claude", "codex"],
          },
        },
      },
    },
  },
}
```

- `endpoint` (required): the final remote receiver URL. Changing it starts fresh delivery to that receiver, including unchanged active sessions; pending terminal retries for the previous receiver are discarded, leaving its rows to expire normally. Redirect responses (301, 302, 303, 307, and 308) are not followed; configure the destination URL directly. After a redirect, repeated polls are suppressed for the current mirror service instance. A Gateway restart probes the configured endpoint once again so a receiver corrected at the same URL can recover. HTTPS is enforced for non-loopback hosts; plaintext `http://` is accepted only for `localhost`/`127.0.0.1`/`::1` development.
- `token`: Gateway credential for the remote receiver, sent as `Authorization: Bearer`. Accepts a plain string or a secret reference; a configured-but-unresolved token pauses mirroring instead of sending unauthenticated requests. Deployments fronted by an identity-aware proxy need an ingress that accepts this bearer credential.
- `catalogs` (required): the session catalog ids to mirror, as explicit per-catalog consent — an omitted or empty list mirrors nothing. The local `beam` receiver catalog is always excluded so two mirrored Gateways cannot re-mirror each other's rows.
- `pollSeconds` (default 30, minimum 10): how often the mirror scans local catalogs.
- `activeWindowMinutes` (default 180): sessions with newer activity than this window count as live and stay mirrored; when a session goes idle past the window the running mirror service retries its final `completed` update until the receiver accepts it or the seven-day retention window ends. Retry state is process-local: a Gateway restart clears pending terminal retries, so the remote row remains live until its normal seven-day retention expires.

The mirror uploads user and agent message text, replacing structured reasoning, tool calls, tool results, and raw payloads with compact counts. Titles and messages pass through OpenClaw's built-in credential masking and configured `logging.redactPatterns` before clipping, even when log redaction is disabled. The manual beam skill additionally strips setup wrappers, local paths, contact identifiers, and opaque values; automatic mirroring does not apply those additional rules. Enable it only for catalogs whose visible message text you intend to share.

The mirror converts newest-first catalog pages into chronological uploads before applying the receiver limits (200 items, 56 KiB), dropping oldest entries first. It marks the upload `truncated` whenever older pages remain, the source reports truncation, or text or items were clipped. Claude catalog pages count individual text, reasoning, and tool blocks and bound their text size. Sessions on paired nodes are not mirrored; the mirror shares only sessions from this Gateway's machine, newest 32 first. A listed session that leaves the active window receives its final completed update even when its catalog has more pages; an absent session is finalized only after a complete, successful host listing.

When browsing Claude sessions on paired nodes, update those nodes alongside the Gateway. Older node builds without block-resume metadata report an update-required error when a mixed row spans pages.

## Troubleshooting

`404 Not Found`

: The Beam plugin is disabled, the Gateway has not reloaded it since enablement, or the request is reaching another Gateway.

`401 Unauthorized`

: The request did not satisfy Gateway HTTP auth. Check the bearer credential or trusted-proxy/Access session.

`405 Method Not Allowed`

: The receiver accepts only `POST`.

`413 Payload Too Large`

: The serialized request exceeded 56 KiB. The official skill drops older sanitized messages until the snapshot fits.

`429 Too Many Requests`

: The authenticated client exceeded the bounded request or concurrency limit. Retry after the current minute window.

`beam mirror upload blocked ... receiver returned redirect`

: The configured mirror endpoint returned a redirect. Beam does not follow redirects and suppresses repeated attempts for the current service instance; set `mirror.endpoint` to the final receiver URL. A Gateway restart probes the configured endpoint once again.

## Related

- [Control UI](/web/control-ui)
- [Control UI URLs](/web/urls)
- [Operator scopes](/gateway/operator-scopes)
- [Trusted proxy auth](/gateway/trusted-proxy-auth)
- [Plugin management](/plugins/manage-plugins)
