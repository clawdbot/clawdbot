---
summary: "Content security policy, authenticated media routes, and approval links"
read_when:
  - Reviewing Control UI browser security
  - Debugging a blocked avatar or assistant media request
  - Forwarding an approval link
title: "Security model"
sidebarTitle: "Security model"
---

How the Control UI restricts the browser and authenticates its own routes.

## Content security policy

The Control UI ships a tight `img-src` policy: **same-origin** assets, `data:` URLs, locally generated `blob:` URLs, and the fixed GitHub avatar and Gravatar hosts are allowed. Other remote `http(s)` and protocol-relative image URLs are rejected by the browser and never issue network fetches.

In practice:

- Avatars and images served under relative paths (for example `/avatars/<id>`) still render, including authenticated avatar routes the UI fetches and converts into local `blob:` URLs.
- Inline `data:image/...` URLs still render.
- Local `blob:` URLs created by the Control UI still render.
- Verified GitHub account avatars render from `avatars.githubusercontent.com`; arbitrary avatar hosts remain blocked.
- GitHub link preview avatars are fetched by the Gateway from GitHub's fixed avatar host and returned as bounded `data:` URLs; the operator browser never contacts the remote avatar host.
- Link favicons are on by default. The authenticated Control UI requests them through the Gateway; the browser never contacts link destinations directly. The Gateway requests only each public hostname's HTTPS `/favicon.ico`, with strict DNS-pinned SSRF checks on the original URL and every redirect plus bounded time, bytes, concurrency, and image validation. Private, internal, and IP-literal destinations are rejected. This discloses linked hostnames and the Gateway's network address to those sites. Set `gateway.controlUi.automaticallyFetchFavicons: false` to prevent all favicon route requests and destination fetches.
- Animated PNG (APNG) icons are accepted as PNG images. Workspace icons and managed channel avatars retain their animation; remote plugin, catalog, and link icons use a resized PNG preview.
- Remote avatar URLs emitted by channel metadata are stripped at the Control UI's avatar helpers and replaced with the built-in logo/badge, so a compromised or malicious channel cannot force arbitrary remote image fetches from an operator browser.

The browser-side CSP restriction itself is always on and not configurable.

## Avatar route auth

When gateway auth is configured, the Control UI avatar endpoint requires the same gateway token as the rest of the API:

- `GET /avatar/<agentId>` returns the avatar image only to authenticated callers. `GET /avatar/<agentId>?meta=1` returns the avatar metadata under the same rule.
- Unauthenticated requests to either route are rejected (matching the sibling assistant-media route), so the avatar route cannot leak agent identity on hosts that are otherwise protected.
- The Control UI forwards the gateway token as a bearer header when fetching avatars, and uses authenticated blob URLs so the image still renders in dashboards.
- Browser avatar URLs include an opaque `v` revision. Static PNG, JPEG, and WebP avatars use cached previews with a maximum side of 128 pixels. Animated images, SVG, and other accepted data-URL formats retain their original bytes and encoding. The sidebar and chat panes share fetched images, and private browser caching avoids downloading unchanged bytes on reload.
- Refreshed metadata uses a new URL after the source changes. Replacing a local avatar file is picked up by the next identity refresh after the shared 60-second freshness window. Conditional requests still require authentication before returning `304 Not Modified`. The revision is a cache key, not an access token; unversioned image requests retain the original image.

If you disable gateway auth (not recommended on shared hosts), the avatar route also becomes unauthenticated, in line with the rest of the gateway.

## Assistant media route auth

Local image previews follow the chat's filesystem permissions. Project chats use
their session workspace, including managed worktrees. Full Access, or disabled
workspace-only filesystem protection, also permits image previews outside that
workspace. An explicit session permission mode takes precedence over the agent's
filesystem setting.

Sessions dispatched to a cloud worker cannot read Gateway-local file paths,
even with Full Access. Dispatch also revokes pending local previews and downloads.
Gateway-owned inbound uploads remain available.

Full Access also preserves playback and downloads for existing attachments in
the agent's configured workspace. It does not permit arbitrary outside
non-image files.

With workspace protection enabled, an outside image shows **Outside allowed
folders**. Hover over its filename to inspect the source path. Administrators can
select **Allow image** to preview that exact file without changing the session's
permissions or allowing its parent folder. The allowance uses a short-lived media
ticket; replacing the file or restarting the Gateway requires a new allowance.

When gateway auth is configured, assistant local-media previews use a two-step route:

- `GET /__openclaw__/assistant-media?meta=1&source=<path>&sessionKey=<key>&agentId=<id>` requires the normal Control UI operator auth and access to the selected session; the browser sends the gateway token as a bearer header when checking availability.
- Successful metadata responses include a short-lived `mediaTicket` scoped to the file and session. Explicit outside-image allowances use an authenticated administrator `POST` to the same route with `meta=1&allow=1`.
- Browser-rendered image, audio, video, and document URLs use `mediaTicket=<ticket>` instead of the active gateway token or password. The ticket expires quickly and cannot authorize a different source.

Tickets remain bound to the issuing reader's current access. Losing session
visibility or role permissions stops new reads through existing tickets, even
before they expire.

This keeps media rendering compatible with browser-native media elements without putting reusable gateway credentials in visible media URLs.

Uploaded and local chat image previews rendered with native image elements keep an already-loaded image visible during temporary connection or metadata-renewal failures. Retention applies only to that mounted image; it does not extend its media ticket or authorize fresh reads. An explicit missing or access-denied response, or a change to the source, credentials, or access scope, clears the retained image.

Uploaded images also stay visible while a new session's workspace or worktree details arrive. Media access is rechecked in the background without replacing the loaded preview with a loading card.

Generated images under `/api/chat/media/outgoing/...` use the same capability
principle through `artifacts.download`. The authenticated WebSocket request
authorizes the transcript artifact and returns a short-lived URL. The HTTP media
route rechecks that the artifact still belongs to the transcript before serving
bytes. The previous shared-owner bearer path remains available for older Control
UI clients during the compatibility window.

## Approval links

Operator approval notifications can deep-link to a [standalone approval document](/web/urls#other-special-documents-and-startup-modes). The URL is stable for the lifetime of the approval and safe to forward between your own devices: it identifies the approval, never authorizes it.

- The approval namespace is reserved by the Gateway ahead of plugin HTTP routes for **all** HTTP methods, so a plugin route can never shadow or intercept an approval document.
- Opening an approval document requires the same gateway auth as the rest of the Control UI (token/password, Tailscale Serve identity, or trusted-proxy identity); credentials are never part of the approval URL.
- When Control UI serving is disabled, requests to the namespace return `404` instead of falling through to plugin handlers.
- Signing in on an approval document is ephemeral for that page: it does not overwrite the gateway selection or settings saved by the full Control UI in the same browser.
