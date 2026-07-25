---
name: feishu-drive
description: |
  Feishu cloud storage file management. Activate when user mentions cloud space, folders, drive.
---

# Feishu Drive Tool

Single tool `feishu_drive` for cloud storage operations.

## Token Extraction

From URL `https://xxx.feishu.cn/drive/folder/ABC123` → `folder_token` = `ABC123`

## Actions

### List Folder Contents

```json
{ "action": "list" }
```

Requests the account root (no `folder_token`). Bot credentials normally have no root folder, so
use a folder that has been shared with the bot instead.

```json
{ "action": "list", "folder_token": "fldcnXXX", "page_size": 100 }
```

Returns one page of files with token, name, type, url, timestamps, and `next_page_token` when
another page is available. To continue, pass the returned token with the same folder token:

```json
{
  "action": "list",
  "folder_token": "fldcnXXX",
  "page_size": 100,
  "page_token": "next-page-token"
}
```

`page_size` must be between 1 and 200. Pagination requires a concrete shared `folder_token`;
root-list cursors are not forwarded.

### Get File Info

```json
{ "action": "info", "file_token": "ABC123", "type": "docx" }
```

Looks up file metadata directly by token and type, regardless of which shared folder contains it.
Shortcuts are the exception: Feishu's metadata API does not support the `shortcut` type, so shortcut
info retains the root-directory lookup behavior.

`type`: `doc`, `docx`, `sheet`, `bitable`, `folder`, `file`, `mindnote`, `shortcut`

### Create Folder

```json
{ "action": "create_folder", "name": "New Folder" }
```

In parent folder:

```json
{ "action": "create_folder", "name": "New Folder", "folder_token": "fldcnXXX" }
```

### Move File

```json
{ "action": "move", "file_token": "ABC123", "type": "docx", "folder_token": "fldcnXXX" }
```

### Delete File

```json
{ "action": "delete", "file_token": "ABC123", "type": "docx" }
```

## File Types

| Type       | Description             |
| ---------- | ----------------------- |
| `doc`      | Old format document     |
| `docx`     | New format document     |
| `sheet`    | Spreadsheet             |
| `bitable`  | Multi-dimensional table |
| `folder`   | Folder                  |
| `file`     | Uploaded file           |
| `mindnote` | Mind map                |
| `shortcut` | Shortcut                |

## Configuration

```yaml
channels:
  feishu:
    tools:
      drive: true # default: true
```

## Permissions

- `drive:drive` - Full access (create, move, delete)
- `drive:drive:readonly` - Read only (list and root-level info fallback)
- `drive:drive.metadata:readonly` - Direct `info` lookup outside the root (not needed with `drive:drive`)

## Known Limitations

- **Bots have no root folder**: Feishu bots use `tenant_access_token` and don't have their own "My Space". The root folder concept only exists for user accounts. This means:
  - `create_folder` without `folder_token` will fail (400 error)
  - Bot can only access files/folders that have been **shared with it**
  - **Workaround**: User must first create a folder manually and share it with the bot, then bot can create subfolders inside it
