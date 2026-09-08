---
summary: "Channel-specific runtime helper groups for chunking, routing, pairing, media, and mentions"
read_when:
  - You are building or maintaining a channel plugin
  - You need channel media download, mention policy, or inbound kernel helpers
title: "Plugin runtime channel helpers"
sidebarTitle: "Channel helpers"
---

Channel-specific runtime helpers, available when a channel plugin is loaded. Part of the [Plugin runtime helpers](/plugins/sdk-runtime) reference; [Channel plugins](/plugins/sdk-channel-plugins) is the step-by-step guide.

## Channel namespaces

<AccordionGroup>
  <Accordion title="api.runtime.channel">
    Channel-specific runtime helpers (available when a channel plugin is loaded). Grouped by concern:

    | Group | Purpose |
    | --- | --- |
    | `text` | Chunking (`chunkText`, `chunkMarkdownText`, `resolveChunkMode`), control-command detection, Markdown table conversion. |
    | `reply` | Buffered-block reply dispatch, envelope formatting, effective messages/human-delay config resolution. |
    | `routing` | `buildAgentSessionKey`, `resolveAgentRoute`. |
    | `pairing` | `buildPairingReply`, allowlist reads/removals, pairing-request upserts, and request-derived approval entries. |
    | `media` | Remote media download/save (see below). |
    | `activity` | Record/read last channel activity. |
    | `session` | Session metadata from inbound events, last-route updates. |
    | `mentions` | Mention-policy helpers (see below). |
    | `reactions` | Ack-reaction handles for in-flight processing indicators. |
    | `groups` | Group policy and require-mention resolution. |
    | `debounce` | Inbound message debouncing. |
    | `commands` | Command authorization and text-command gating. |
    | `outbound` | Load a channel's outbound adapter. |
    | `inbound` | Build inbound event context and run the shared inbound-event/reply kernel. |
    | `threadBindings` | Adjust idle-timeout/max-age for bound session threads. |
    | `runtimeContexts` | Register, read, and watch process-local per-channel/account/capability context. |

    `api.runtime.channel.media` is the preferred surface for channel media downloads and storage:

    ```typescript
    const saved = await api.runtime.channel.media.saveRemoteMedia({
      url,
      subdir: "inbound",
      maxBytes,
      filePathHint: fileName,
    });
    ```

    Use `saveRemoteMedia(...)` when a remote URL should become OpenClaw media. Use `saveResponseMedia(...)` when the plugin already fetched a `Response` with plugin-owned auth, redirect, or allowlist handling. Use `readRemoteMediaBuffer(...)` only when the plugin needs raw bytes for inspection, transforms, decryption, or reupload. `fetchRemoteMedia(...)` remains a deprecated compatibility alias for `readRemoteMediaBuffer(...)`.

    For unsuccessful HTTP responses, media errors report the status and include a bounded body excerpt when available. A discarded error body is not reported as an empty upstream response. A successful response with no body is still rejected as empty media.

    Remote media options and `fetchWithSsrFGuard(...)` from `openclaw/plugin-sdk/ssrf-runtime` accept a synchronous `beforeRequest` callback for final-dispatch authorization checks. It runs after proxy, DNS, and dispatcher preparation and immediately before every physical request. Redirects invoke it once per hop; media retries invoke it again for every attempt and hop. If it throws, that request is not sent and the same error propagates. Promise or thenable results are rejected before transport dispatch.

    Guarded fetch also accepts a synchronous `resolveDispatcherPolicy(url)` override, reevaluated for each redirect. An undefined result uses `dispatcherPolicy`, or direct routing when no default policy is supplied. Providers preserving operator-configured proxy routing can use `resolveEnvHttpProxyAgentOptions` and `matchesNoProxy` from `openclaw/plugin-sdk/fetch-runtime` to select each hop. The `trusted_explicit_proxy` mode permits HTTP, HTTPS, `socks:` and `socks5:` proxy URLs and delegates target DNS to the explicitly trusted proxy; proxy-host validation and target-host policy still apply. Direct hops keep DNS pinning. Strict mode rejects SOCKS proxies, and the separate trusted-env-proxy gate remains HTTP(S)-only.

    `api.runtime.channel.mentions` is the shared inbound mention-policy surface for bundled channel plugins that use runtime injection:

    ```typescript
    const mentionMatch = api.runtime.channel.mentions.matchesMentionWithExplicit(text, {
      mentionRegexes,
      mentionPatterns,
    });

    const decision = api.runtime.channel.mentions.resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: mentionMatch.matched,
        implicitMentionKinds: api.runtime.channel.mentions.implicitMentionKindWhen(
          "reply_to_bot",
          isReplyToBot,
        ),
      },
      policy: {
        isGroup,
        requireMention,
        allowTextCommands,
        hasControlCommand,
        commandAuthorized,
      },
    });
    ```

    Available mention helpers:

    - `buildMentionRegexes`
    - `matchesMentionPatterns`
    - `matchesMentionWithExplicit`
    - `implicitMentionKindWhen`
    - `resolveInboundMentionDecision`

    Use the normalized `{ facts, policy }` path for mention decisions.

    Several fields under `reply`, `session`, and `inbound` carry per-field `@deprecated` notes pointing at the current channel-turn kernel or channel-outbound adapters; check the inline JSDoc on the specific helper before building new code on it.

  </Accordion>
</AccordionGroup>
