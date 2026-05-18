---
name: xurl
description: "xurl CLI for authenticated X posts, replies, reads/search, DMs, media upload, followers, auth status, or raw v2 API calls."
metadata:
  {
    "openclaw":
      {
        "emoji": "🐦",
        "requires": { "bins": ["xurl"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "xdevplatform/tap/xurl",
              "bins": ["xurl"],
              "label": "Install xurl (brew)",
            },
            {
              "id": "npm",
              "kind": "npm",
              "package": "@xdevplatform/xurl",
              "bins": ["xurl"],
              "label": "Install xurl (npm)",
            },
          ],
      },
  }
---

# xurl

Use `xurl` for X API work. Shortcut commands return JSON; raw mode works for any v2 endpoint.

## Secret safety

- Never read, print, summarize, upload, or inspect `~/.xurl`.
- Never ask user to paste tokens/secrets into chat.
- Do not run auth commands with inline secrets.
- Do not use `--verbose` in agent sessions; it can expose auth headers.
- Check auth with `xurl auth status`.

## Common shortcuts

```bash
xurl post "Hello world!"
xurl reply POST_ID "Nice."
xurl quote POST_ID "My take"
xurl delete POST_ID
xurl read POST_ID
xurl search "query" -n 20
xurl whoami
xurl user @handle
xurl timeline -n 20
xurl mentions -n 10
xurl like POST_ID
xurl unlike POST_ID
xurl repost POST_ID
xurl unrepost POST_ID
xurl bookmark POST_ID
xurl unbookmark POST_ID
xurl followers -n 20
xurl following -n 20
xurl follow @handle
xurl unfollow @handle
xurl block @handle
xurl unblock @handle
xurl mute @handle
xurl unmute @handle
xurl dm @handle "message"
xurl dms -n 10
```

`POST_ID` can be a full `https://x.com/<user>/status/<id>` URL.

## Media

```bash
xurl media upload image.jpg
xurl media upload clip.mp4
xurl media status MEDIA_ID
xurl post "caption" --media-id MEDIA_ID
```

Videos may need processing; poll `media status`.

## Auth/app management

```bash
xurl auth status
xurl auth apps list
xurl auth default
xurl auth default APP_NAME USERNAME
xurl auth apps remove APP_NAME
```

Per request:

```bash
xurl --app APP_NAME /2/users/me
xurl --auth oauth2 /2/users/me
```

## Raw API

```bash
xurl /2/users/me
xurl -X POST /2/tweets -d '{"text":"Hello world!"}'
xurl '/2/tweets/search/recent?query=openclaw&max_results=10'
```

Use raw mode when shortcuts do not cover the endpoint. Keep payloads in temp files for complex JSON.

## Output and errors

- JSON stdout on success.
- Non-zero exit on API/auth/network errors.
- 401/403: auth, scope, or app mismatch; check `xurl auth status`.
- 429: rate limited; back off.
- Media upload failures: check file type/size and media processing status.
