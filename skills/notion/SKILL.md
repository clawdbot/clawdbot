---
name: notion
description: "Notion CLI/API for pages, Markdown content, data sources, files, comments, search, Workers, and raw API calls."
homepage: https://developers.notion.com/cli/get-started/overview
metadata:
  {
    "openclaw":
      {
        "emoji": "📝",
        "requires": { "anyBins": ["ntn", "curl"] },
        "primaryEnv": "NOTION_API_TOKEN",
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "ntn",
              "bins": ["ntn"],
              "label": "Install official Notion CLI (npm)",
            },
          ],
      },
  }
---

# Notion

Prefer official `ntn` CLI. Use curl only when `ntn` is unavailable or a raw request is clearer.

## Setup

```bash
npm install -g ntn
ntn --version
ntn login
```

Script/headless auth:

```bash
export NOTION_API_TOKEN=secret_or_ntn_token
export NOTION_API_VERSION=2026-03-11
```

`ntn api` sets `Authorization` and `Notion-Version` automatically. It uses CLI login by default, or `NOTION_API_TOKEN` when set.

## Inspect

```bash
ntn doctor
ntn api ls
ntn api ls --json
ntn api v1/comments --help
ntn api v1/comments --spec -X POST
ntn api v1/comments --docs -X POST
```

## Pages

Markdown-first helpers:

```bash
ntn pages get <page-id>
ntn pages get <page-id> --json
ntn pages create --parent page:<page-id> --content '# Title\n\nBody'
ntn pages create --parent data-source:<data-source-id> < page.md
ntn pages update <page-id> --content '# Updated'
ntn pages update <page-id> < page.md
ntn pages trash <page-id> --yes
```

Notes:

- `pages get` prints Markdown with page properties as frontmatter.
- Content input: `--content`, stdin, or editor in a TTY.
- Parent refs: `page:<id>`, `database:<id>`, `data-source:<id>`.
- For properties/templates/full Pages API, use `ntn api v1/pages`.

## Data sources

```bash
ntn datasources resolve <database-id>
ntn datasources resolve <database-id> --json
ntn datasources query <data-source-id>
ntn datasources query <data-source-id> --limit 50 --json
ntn datasources query <data-source-id> --sort 'Date desc'
ntn datasources query <data-source-id> --filter '{"property":"Done","checkbox":{"equals":true}}'
```

Use `resolve` when you have a database ID. Query needs a data source ID.

## Raw API

```bash
ntn api v1/users/me
ntn api v1/search query=roadmap page_size:=10
ntn api v1/pages 'parent[data_source_id]='"$DS_ID" 'properties[Name][title][0][text][content]=New item'
ntn api "v1/pages/$PAGE_ID" -X PATCH in_trash:=true
ntn api "v1/blocks/$PAGE_ID/children" -X PATCH \
  'children[0][type]=paragraph' \
  'children[0][paragraph][rich_text][0][text][content]=Hello'
```

Input syntax:

- `path=value`: string body field.
- `path:=json`: typed JSON body field.
- `name==value`: query parameter.
- `Header:Value`: request header.
- `--data '<json>'` or stdin JSON for larger bodies.
- Only one body source per request.

## Files

```bash
ntn files create < image.png
ntn files create --filename photo.png --content-type image/png < /tmp/photo
ntn files create --external-url https://example.com/photo.png
ntn files get <upload-id>
ntn files list
```

## Workers

```bash
ntn workers new
ntn workers deploy
ntn workers list --json
ntn workers runs list --json
ntn workers runs logs <run-id>
```

Workers may require Business/Enterprise plan and workspace enablement.

## Curl fallback

```bash
curl -sS "https://api.notion.com/v1/users/me" \
  -H "Authorization: Bearer $NOTION_API_TOKEN" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json"
```

## Version notes

- Current latest API version: `2026-03-11`.
- Use `in_trash`, not `archived`.
- Append block positioning uses `position`, not flat `after`.
- `transcription` block renamed to `meeting_notes`.
- Databases can contain multiple data sources; page parents generally use `data_source_id`.
