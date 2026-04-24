---
name: xurl
description: Use xurl for authenticated X API posts, replies, search, DMs, media upload, followers, or raw v2 calls.
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

# xurl — Agent Skill Reference

`xurl` is a CLI tool for the X API. It supports both **shortcut commands** (human/agent‑friendly one‑liners) and **raw curl‑style** access to any v2 endpoint. All commands return JSON to stdout.

---

## Installation

### Homebrew (macOS)

```bash
brew install --cask xdevplatform/tap/xurl
```

### npm

```bash
npm install -g @xdevplatform/xurl
```

### Shell script

```bash
curl -fsSL https://raw.githubusercontent.com/xdevplatform/xurl/main/install.sh | bash
```

Installs to `~/.local/bin`. If it's not in your PATH, the script will tell you what to add.

### Go

```bash
go install github.com/xdevplatform/xurl@latest
```

---

## Prerequisites

This skill requires the `xurl` CLI utility: <https://github.com/xdevplatform/xurl>.

Before using any command you must be authenticated. Run `xurl auth status` to check.

### Secret Safety (Mandatory)

- Never read, print, parse, summarize, upload, or send `~/.xurl` (or copies of it) to the LLM context.
- Never ask the user to paste credentials/tokens into chat.
- The user must fill `~/.xurl` with required secrets manually on their own machine.
- Do not recommend or execute auth commands with inline secrets in agent/LLM sessions.
- Warn that using CLI secret options in agent sessions can leak credentials (prompt/context, logs, shell history).
- Never use `--verbose` / `-v` in agent/LLM sessions; it can expose sensitive headers/tokens in output.
- Sensitive flags that must never be used in agent commands: `--bearer-token`, `--consumer-key`, `--consumer-secret`, `--access-token`, `--token-secret`, `--client-id`, `--client-secret`.
- To verify whether at least one app with credentials is already registered, run: `xurl auth status`.

### Register an app (recommended)

App credential registration must be done manually by the user outside the agent/LLM session.
After credentials are registered, authenticate with:

```bash
xurl auth oauth2
```

For multiple pre-configured apps, switch between them:

```bash
xurl auth default prod-app          # set default app
xurl auth default prod-app alice    # set default app + user
xurl --app dev-app /2/users/me      # one-off override
```

### Other auth methods

Examples with inline secret flags are intentionally omitted. If OAuth1 or app-only auth is needed, the user must run those commands manually outside agent/LLM context.

Tokens are persisted to `~/.xurl` in YAML format. Each app has its own isolated tokens. Do not read this file through the agent/LLM. Once authenticated, every command below will auto‑attach the right `Authorization` header.

---

## Quick Reference

| Action                    | Command                                               |
| ------------------------- | ----------------------------------------------------- |
| Post                      | `xurl post "Hello world!"`                            |
| Reply                     | `xurl reply POST_ID "Nice post!"`                     |
| Quote                     | `xurl quote POST_ID "My take"`                        |
| Delete a post             | `xurl delete POST_ID`                                 |
| Read a post               | `xurl read POST_ID`                                   |
| Search posts              | `xurl search "QUERY" -n 10`                           |
| Who am I                  | `xurl whoami`                                         |
| Look up a user            | `xurl user @handle`                                   |
| Home timeline             | `xurl timeline -n 20`                                 |
| Mentions                  | `xurl mentions -n 10`                                 |
| Like                      | `xurl like POST_ID`                                   |
| Unlike                    | `xurl unlike POST_ID`                                 |
| Repost                    | `xurl repost POST_ID`                                 |
| Undo repost               | `xurl unrepost POST_ID`                               |
| Bookmark                  | `xurl bookmark POST_ID`                               |
| Remove bookmark           | `xurl unbookmark POST_ID`                             |
| List bookmarks            | `xurl bookmarks -n 10`                                |
| List likes                | `xurl likes -n 10`                                    |
| Follow                    | `xurl follow @handle`                                 |
| Unfollow                  | `xurl unfollow @handle`                               |
| List following            | `xurl following -n 20`                                |
| List followers            | `xurl followers -n 20`                                |
| Block                     | `xurl block @handle`                                  |
| Unblock                   | `xurl unblock @handle`                                |
| Mute                      | `xurl mute @handle`                                   |
| Unmute                    | `xurl unmute @handle`                                 |
| Send DM                   | `xurl dm @handle "message"`                           |
| List DMs                  | `xurl dms -n 10`                                      |
| Upload media              | `xurl media upload path/to/file.mp4`                  |
| Media status              | `xurl media status MEDIA_ID`                          |
| **App Management**        |                                                       |
| Register app              | Manual, outside agent (do not pass secrets via agent) |
| List apps                 | `xurl auth apps list`                                 |
| Update app creds          | Manual, outside agent (do not pass secrets via agent) |
| Remove app                | `xurl auth apps remove NAME`                          |
| Set default (interactive) | `xurl auth default`                                   |
| Set default (command)     | `xurl auth default APP_NAME [USERNAME]`               |
| Use app per-request       | `xurl --app NAME /2/users/me`                         |
| Auth status               | `xurl auth status`                                    |

> **Post IDs vs URLs:** Anywhere `POST_ID` appears above you can also paste a full post URL (e.g. `https://x.com/user/status/1234567890`) — xurl extracts the ID automatically.

> **Usernames:** Leading `@` is optional. `@elonmusk` and `elonmusk` both work.

---

## Command Details

### Posting

```bash
# Simple post
xurl post "Hello world!"

# Post with media (upload first, then attach)
xurl media upload photo.jpg          # → note the media_id from response
xurl post "Check this out" --media-id MEDIA_ID

# Multiple media
xurl post "Thread pics" --media-id 111 --media-id 222

# Reply to a post (by ID or URL)
xurl reply 1234567890 "Great point!"
xurl reply https://x.com/user/status/1234567890 "Agreed!"

# Reply with media
xurl reply 1234567890 "Look at this" --media-id MEDIA_ID

# Quote a post
xurl quote 1234567890 "Adding my thoughts"

# Delete your own post
xurl delete 1234567890
```

### Reading

```bash
# Read a single post (returns author, text, metrics, entities)
xurl read 1234567890
xurl read https://x.com/user/status/1234567890

# Search recent posts (default 10 results)
xurl search "golang"
xurl search "from:elonmusk" -n 20
xurl search "#buildinpublic lang:en" -n 15
```

### User Info

```bash
# Your own profile
xurl whoami

# Look up any user
xurl user elonmusk
xurl user @XDevelopers
```

### Timelines & Mentions

```bash
# Home timeline (reverse chronological)
xurl timeline
xurl timeline -n 25

# Your mentions
xurl mentions
xurl mentions -n 20
```

### Engagement

```bash
# Like / unlike
xurl like 1234567890
xurl unlike 1234567890

# Repost / undo
xurl repost 1234567890
xurl unrepost 1234567890

# Bookmark / remove
xurl bookmark 1234567890
xurl unbookmark 1234567890

# List your bookmarks / likes
xurl bookmarks -n 20
xurl likes -n 20
```

### Social Graph

```bash
# Follow / unfollow
xurl follow @XDevelopers
xurl unfollow @XDevelopers

# List who you follow / your followers
xurl following -n 50
xurl followers -n 50

# List another user's following/followers
xurl following --of elonmusk -n 20
xurl followers --of elonmusk -n 20

# Block / unblock
xurl block @spammer
xurl unblock @spammer

# Mute / unmute
xurl mute @annoying
xurl unmute @annoying
```

### Direct Messages

```bash
# Send a DM
xurl dm @someuser "Hey, saw your post!"

# List recent DM events
xurl dms
xurl dms -n 25
```

### Media Upload

```bash
# Upload a file (auto‑detects type for images/videos)
xurl media upload photo.jpg
xurl media upload video.mp4

# Specify type and category explicitly
xurl media upload --media-type image/jpeg --category tweet_image photo.jpg

# Check processing status (videos need server‑side processing)
xurl media status MEDIA_ID
xurl media status --wait MEDIA_ID    # poll until done

# Full workflow: upload then post
xurl media upload meme.png           # response includes media id
xurl post "lol" --media-id MEDIA_ID
```

---

## Global Flags

These flags work on every command:

| Flag         | Short | Description                                                        |
| ------------ | ----- | ------------------------------------------------------------------ |
| `--app`      |       | Use a specific registered app for this request (overrides default) |
| `--auth`     |       | Force auth type: `oauth1`, `oauth2`, or `app`                      |
| `--username` | `-u`  | Which OAuth2 account to use (if you have multiple)                 |
| `--verbose`  | `-v`  | Forbidden in agent/LLM sessions (can leak auth headers/tokens)     |
| `--trace`    | `-t`  | Add `X-B3-Flags: 1` trace header                                   |

---

## Raw API Access

The shortcut commands cover the most common operations. For anything else, use xurl's raw curl‑style mode — it works with **any** X API v2 endpoint:

```bash
# GET request (default)
xurl /2/users/me

# POST with JSON body
xurl -X POST /2/tweets -d '{"text":"Hello world!"}'

# PUT, PATCH, DELETE
xurl -X DELETE /2/tweets/1234567890

# Custom headers
xurl -H "Content-Type: application/json" /2/some/endpoint

# Force streaming mode
xurl -s /2/tweets/search/stream

# Full URLs also work
xurl https://api.x.com/2/users/me
```

---

## Streaming

Streaming endpoints are auto‑detected. Known streaming endpoints include:

- `/2/tweets/search/stream`
- `/2/tweets/sample/stream`
- `/2/tweets/sample10/stream`

You can force streaming on any endpoint with `-s`:

```bash
xurl -s /2/some/endpoint
```

---

## Output Format

All commands return **JSON** to stdout, pretty‑printed with syntax highlighting. The output structure matches the X API v2 response format. A typical response looks like:

```json
{
  "data": {
    "id": "1234567890",
    "text": "Hello world!"
  }
}
```

Errors are also returned as JSON:

```json
{
  "errors": [
    {
      "message": "Not authorized",
      "code": 403
    }
  ]
}
```

---

## Common Workflows

### Post with an image

```bash
# 1. Upload the image
xurl media upload photo.jpg
# 2. Copy the media_id from the response, then post
xurl post "Check out this photo!" --media-id MEDIA_ID
```

### Reply to a conversation

```bash
# 1. Read the post to understand context
xurl read https://x.com/user/status/1234567890
# 2. Reply
xurl reply 1234567890 "Here are my thoughts..."
```

### Search and engage

```bash
# 1. Search for relevant posts
xurl search "topic of interest" -n 10
# 2. Like an interesting one
xurl like POST_ID_FROM_RESULTS
# 3. Reply to it
xurl reply POST_ID_FROM_RESULTS "Great point!"
```

### Check your activity

```bash
# See who you are
xurl whoami
# Check your mentions
xurl mentions -n 20
# Check your timeline
xurl timeline -n 20
```

### Set up multiple apps

```bash
# App credentials must already be configured manually outside agent/LLM context.
# Authenticate users on each pre-configured app
xurl auth default prod
xurl auth oauth2                       # authenticates on prod app

xurl auth default staging
xurl auth oauth2                       # authenticates on staging app

# Switch between them
xurl auth default prod alice           # prod app, alice user
xurl --app staging /2/users/me         # one-off request against staging
```

---

## Error Handling

- Non‑zero exit code on any error.
- API errors are printed as JSON to stdout (so you can still parse them).
- Auth errors suggest re‑running `xurl auth oauth2` or checking your tokens.
- If a command requires your user ID (like, repost, bookmark, follow, etc.), xurl will automatically fetch it via `/2/users/me`. If that fails, you'll see an auth error.

---

## Notes

- **Rate limits:** The X API enforces rate limits per endpoint. If you get a 429 error, wait and retry. Write endpoints (post, reply, like, repost) have stricter limits than read endpoints.
- **Scopes:** OAuth 2.0 tokens are requested with broad scopes. If you get a 403 on a specific action, your token may lack the required scope — re‑run `xurl auth oauth2` to get a fresh token.
- **Token refresh:** OAuth 2.0 tokens auto‑refresh when expired. No manual intervention needed.
- **Multiple apps:** Each app has its own isolated credentials and tokens. Configure credentials manually outside agent/LLM context, then switch with `xurl auth default` or `--app`.
- **Multiple accounts:** You can authenticate multiple OAuth 2.0 accounts per app and switch between them with `--username` / `-u` or set a default with `xurl auth default APP USER`.
- **Default user:** When no `-u` flag is given, xurl uses the default user for the active app (set via `xurl auth default`). If no default user is set, it uses the first available token.
- **Token storage:** `~/.xurl` is YAML. Each app stores its own credentials and tokens. Never read or send this file to LLM context.
