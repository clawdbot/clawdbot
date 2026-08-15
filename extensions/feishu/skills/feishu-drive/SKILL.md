---
name: feishu-drive
description: |
  Feishu cloud-storage and comment workflows. Activate when the user mentions cloud space, folders, Drive files, or document comments.
---

# Feishu Drive

Use the single `feishu_drive` tool and its current action schema.

From `https://example.feishu.cn/drive/folder/ABC123`, use `ABC123` as `folder_token`.

## Files and folders

- Start from a folder shared with the bot. Bot credentials normally have no usable personal root folder.
- For paginated folder listings, keep the same `folder_token` and pass the returned `page_token` until no continuation token remains.
- Use `info` with the exact file token and type returned by Drive or wiki discovery.
- Resolve the exact source and destination before moving or deleting. Confirm destructive deletes when the user's intent or target is unclear.
- Create subfolders inside a shared folder; creating at the account root normally fails for bots.

## Comments

- Use `list_comments`, then `list_comment_replies` with the exact `comment_id` to inspect a discussion.
- Use `add_comment` for a document-level comment. Include `block_id` only when the user wants a comment on one known Docx block.
- Use `reply_comment` for an existing comment thread.
- Preserve the file type and pagination fields returned by the tool. The schema is authoritative for which file types each comment action accepts.

Only expose or forward file and comment contents needed for the user's request; shared Drive data may be private.
