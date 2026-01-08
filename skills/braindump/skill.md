# Braindump Skill

Braindump is a macOS CLI & MCP server for Apple Notes and Reminders.

## Installation

```bash
cd /Users/cortex-mini/Developer/Braindump
swift build -c release
cp .build/release/braindump /usr/local/bin/
```

## CLI Commands

### Notes

```bash
braindump notes list [--folder <name>] [--json]
braindump notes get <id> [--json]
braindump notes create --title <title> [--body <body>] [--folder <folder>]
braindump notes search <query> [--json]
braindump notes delete <id> [--force]
braindump notes folders [--json]
```

### Reminders

```bash
braindump reminders list [--list <name>] [--all] [--json]
braindump reminders get <id> [--json]
braindump reminders create --title <title> [--list <list>] [--due <date>] [--notes <notes>] [--priority <0-9>]
braindump reminders complete <id> [--undo]
braindump reminders delete <id> [--force]
braindump reminders search <query> [--json]
braindump reminders lists [--json]
```

### MCP Server

```bash
braindump mcp serve    # Start MCP server (stdio transport)
braindump mcp tools    # List available tools
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `notes_list` | List all notes (optional folder filter) |
| `notes_get` | Get note by ID |
| `notes_create` | Create new note |
| `notes_search` | Search notes |
| `notes_delete` | Delete note |
| `notes_folders` | List folders |
| `reminders_list` | List reminders |
| `reminders_get` | Get reminder by ID |
| `reminders_create` | Create reminder |
| `reminders_complete` | Mark complete/incomplete |
| `reminders_delete` | Delete reminder |
| `reminders_search` | Search reminders |
| `reminders_lists` | List reminder lists |

## MCP Configuration

Add to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "braindump": {
      "command": "braindump",
      "args": ["mcp", "serve"]
    }
  }
}
```

## Date Formats

- ISO8601: `2026-01-05`, `2026-01-05 18:00`
- Priority: 0 (none), 1 (high), 5 (medium), 9 (low)
