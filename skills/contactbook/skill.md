# Contactbook Skill

Contactbook is a macOS CLI & MCP server for Apple Contacts.

## Installation

```bash
cd /Users/cortex-mini/Developer/Contactbook
swift build -c release
cp .build/release/contactbook /usr/local/bin/
```

## CLI Commands

### Contacts

```bash
contactbook contacts list [--limit <n>] [--json]
contactbook contacts search <query> [--json]
contactbook contacts get <id> [--json]
contactbook contacts create --first <name> [--last <name>] [--phone <number>] [--email <addr>] [--org <company>]
contactbook contacts update <id> [--first <name>] [--last <name>] [--phone <number>] [--email <addr>] [--org <company>]
contactbook contacts delete <id> [--force]
```

### Groups

```bash
contactbook groups list [--json]
contactbook groups members <group-name> [--json]
```

### MCP Server

```bash
contactbook mcp serve    # Start MCP server (stdio transport)
contactbook mcp tools    # List available tools
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `contacts_list` | List contacts with optional limit |
| `contacts_search` | Search by name, email, phone, or org |
| `contacts_get` | Get contact by ID |
| `contacts_create` | Create new contact |
| `contacts_update` | Update existing contact |
| `contacts_delete` | Delete contact |
| `groups_list` | List all contact groups |
| `groups_members` | Get members of a group |

## MCP Configuration

Add to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "contactbook": {
      "command": "contactbook",
      "args": ["mcp", "serve"]
    }
  }
}
```

## Notes

- Default limit is 50 contacts (user has 4500+ contacts)
- Contact IDs are in format `UUID:ABPerson`
- Search matches name, email, phone, and organization fields
