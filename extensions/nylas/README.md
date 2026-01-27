# Nylas Plugin for Moltbot

Email, calendar, and contacts integration via Nylas API v3.

Built on the [official Nylas Node SDK](https://www.npmjs.com/package/nylas).

## Quick Start

1. **Get API Key** - Sign up at https://dashboard.nylas.com and create an API key
2. **Add API key to config:**
   ```yaml
   plugins:
     entries:
       nylas:
         config:
           apiKey: "nyk_v0_your_key_here"
   ```
3. **Auto-discover grants:**
   ```bash
   moltbot nylas status
   ```
   This will connect to Nylas, discover all authenticated accounts, and show the recommended configuration.

## Prerequisites

Before using this plugin, you need to set up a Nylas account:

1. **Create Nylas Account** - Sign up at https://dashboard.nylas.com
2. **Create Application** - All apps → Create new app → Choose region (US/EU)
3. **Get API Key** - API Keys section → Create new key
4. **Add Grants** - Grants section → Add Account → Authenticate email accounts
5. **Grant IDs are auto-discovered** - The plugin will automatically find your authenticated accounts

## Configuration

Add the following to your `moltbot.yaml`:

```yaml
plugins:
  entries:
    nylas:
      enabled: true
      config:
        apiKey: "nyk_v0_..."                 # Required: API key from Nylas dashboard
        apiUri: "https://api.us.nylas.com"   # Optional: US or EU region
        defaultTimezone: "America/New_York"  # Optional: Default timezone for dates
        defaultGrantId: "grant-id-here"      # Primary account's grant ID
        grants:                              # Optional: Named grants for multi-account
          work: "grant-id-for-work-email"
          personal: "grant-id-for-personal"
```

## CLI Commands

```bash
# Check API connection and auto-discover grants (recommended first step)
moltbot nylas status

# Discover all authenticated accounts and show config snippet
moltbot nylas discover
moltbot nylas discover --json  # Output as JSON

# Test API with specific grant (auto-discovers if not configured)
moltbot nylas test
moltbot nylas test --grant work

# List configured and available grants
moltbot nylas grants
moltbot nylas grants --configured  # Only show configured grants
```

## Available Tools

### Account Discovery

| Tool | Description |
|------|-------------|
| `nylas_discover_grants` | Discover all authenticated email accounts (grants) available via this API key |

### Email Tools

| Tool | Description |
|------|-------------|
| `nylas_list_emails` | List/search emails with filters (folder, from, subject, date, unread, starred) |
| `nylas_get_email` | Get full email content by ID |
| `nylas_send_email` | Send email (to, cc, bcc, subject, body) |
| `nylas_create_draft` | Create email draft |
| `nylas_list_threads` | List email threads (conversations) |
| `nylas_list_folders` | List email folders (INBOX, SENT, etc.) |

### Calendar Tools

| Tool | Description |
|------|-------------|
| `nylas_list_calendars` | List available calendars |
| `nylas_list_events` | List/search events with date range |
| `nylas_get_event` | Get event details |
| `nylas_create_event` | Create event with attendees, location |
| `nylas_update_event` | Update existing event |
| `nylas_delete_event` | Delete event |
| `nylas_check_availability` | Check availability for participants |

### Contact Tools

| Tool | Description |
|------|-------------|
| `nylas_list_contacts` | List/search contacts |
| `nylas_get_contact` | Get contact details |

## Multi-Account Support

Use the optional `grant` parameter on any tool to specify which account to use:

```
// Use the default grant
nylas_list_emails({ folder: "INBOX" })

// Use a named grant
nylas_list_emails({ grant: "work", folder: "INBOX" })

// Use a raw grant ID
nylas_list_emails({ grant: "abc123-grant-id", folder: "INBOX" })
```

## Example Usage

**List recent unread emails:**
```
nylas_list_emails({ unread: true, limit: 10 })
```

**Send an email:**
```
nylas_send_email({
  to: "recipient@example.com",
  subject: "Hello",
  body: "<p>This is the email body.</p>"
})
```

**Create a calendar event:**
```
nylas_create_event({
  calendar_id: "primary",
  title: "Team Meeting",
  start: "2024-03-20T14:00:00-05:00",
  end: "2024-03-20T15:00:00-05:00",
  participants: "alice@example.com, bob@example.com",
  location: "Conference Room A"
})
```

**Check availability:**
```
nylas_check_availability({
  emails: "alice@example.com, bob@example.com",
  start: "2024-03-20T09:00:00-05:00",
  end: "2024-03-20T17:00:00-05:00",
  duration_minutes: 30
})
```

## Troubleshooting

**"apiKey is required"**
- Add your Nylas API key to the plugin configuration

**"No grant ID provided"**
- Set `defaultGrantId` or pass `grant` parameter to tools

**401 Unauthorized**
- Check that your API key is valid and not expired
- Verify the grant ID exists in your Nylas dashboard

**404 Not Found**
- Ensure the resource (message, event, contact) ID is correct
- Check that you're using the right grant for that resource

## Support

For Nylas API issues, contact:
- limitless@nylas.com
- support@nylas.com

## Nylas Documentation

- [Nylas API v3 Docs](https://developer.nylas.com/docs/v3/)
- [Nylas Dashboard](https://dashboard.nylas.com)
