---
summary: "Microsoft Teams bot support status, capabilities, and configuration"
read_when:
  - Working on Microsoft Teams channel features
title: "Microsoft Teams"
---

Status: text + DM attachments are supported; channel/group file sending requires `sharePointSiteId` + Graph permissions (see [Sending files in group chats](#sending-files-in-group-chats)). Polls are sent via Adaptive Cards. Message actions expose explicit `upload-file` for file-first sends.

## Bundled plugin

Microsoft Teams ships as a bundled plugin in current OpenClaw releases, so no
separate install is required in the normal packaged build.

If you are on an older build or a custom install that excludes bundled Teams,
install the npm package directly:

```bash
openclaw plugins install @openclaw/msteams
```

Use the bare package to follow the current official release tag. Pin an exact
version only when you need a reproducible install.

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./path/to/local/msteams-plugin
```

Details: [Plugins](/tools/plugin)

## Quick setup

The [`@microsoft/teams.cli`](https://www.npmjs.com/package/@microsoft/teams.cli) handles bot registration, manifest creation, and credential generation in a single command.

**1. Install and log in**

```bash
npm install -g @microsoft/teams.cli@preview
teams login
teams status   # verify you're logged in and see your tenant info
```

<Note>
The Teams CLI is currently in preview. Commands and flags may change between releases.
</Note>

**2. Start a tunnel** (Teams can't reach localhost)

Install and authenticate the devtunnel CLI if you haven't already ([getting started guide](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started)).

```bash
# One-time setup (persistent URL across sessions):
devtunnel create my-openclaw-bot --allow-anonymous
devtunnel port create my-openclaw-bot -p 3978 --protocol auto

# Each dev session:
devtunnel host my-openclaw-bot
# Your endpoint: https://<tunnel-id>.devtunnels.ms/api/messages
```

<Note>
`--allow-anonymous` is required because Teams cannot authenticate with devtunnels. Each incoming bot request is still validated by the Teams SDK automatically.
</Note>

Alternatives: `ngrok http 3978` or `tailscale funnel 3978` (but these may change URLs each session).

**3. Create the app**

```bash
teams app create \
  --name "OpenClaw" \
  --endpoint "https://<your-tunnel-url>/api/messages"
```

This single command:

- Creates an Entra ID (Azure AD) application
- Generates a client secret
- Builds and uploads a Teams app manifest (with icons)
- Registers the bot (Teams-managed by default — no Azure subscription needed)

The output will show `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID`, and a **Teams App ID** — note these for the next steps. It also offers to install the app in Teams directly.

**4. Configure OpenClaw** using the credentials from the output:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<CLIENT_ID>",
      appPassword: "<CLIENT_SECRET>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Or use environment variables directly: `MSTEAMS_APP_ID`, `MSTEAMS_APP_PASSWORD`, `MSTEAMS_TENANT_ID`.

**5. Install the app in Teams**

`teams app create` will prompt you to install the app — select "Install in Teams". If you skipped it, you can get the link later:

```bash
teams app get <teamsAppId> --install-link
```

**6. Verify everything works**

```bash
teams app doctor <teamsAppId>
```

This runs diagnostics across bot registration, AAD app config, manifest validity, and SSO setup.

For production deployments, consider using [federated authentication](/channels/msteams#federated-authentication-certificate-plus-managed-identity) (certificate or managed identity) instead of client secrets.

<Note>
Group chats are blocked by default (`channels.msteams.groupPolicy: "allowlist"`). To allow group replies, set `channels.msteams.groupAllowFrom`, or use `groupPolicy: "open"` to allow any member (mention-gated).
</Note>

## Goals

- Talk to OpenClaw via Teams DMs, group chats, or channels.
- Keep routing deterministic: replies always go back to the channel they arrived on.
- Default to safe channel behavior (mentions required unless configured otherwise).

## Config writes

By default, Microsoft Teams is allowed to write config updates triggered by `/config set|unset` (requires `commands.config: true`).

Disable with:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## Access control (DMs + groups)

**DM access**

- Default: `channels.msteams.dmPolicy = "pairing"`. Unknown senders are ignored until approved.
- `channels.msteams.allowFrom` should use stable AAD object IDs.
- Do not rely on UPN/display-name matching for allowlists — they can change. OpenClaw disables direct name matching by default; opt in explicitly with `channels.msteams.dangerouslyAllowNameMatching: true`.
- The wizard can resolve names to IDs via Microsoft Graph when credentials allow.

**Group access**

- Default: `channels.msteams.groupPolicy = "allowlist"` (blocked unless you add `groupAllowFrom`). Use `channels.defaults.groupPolicy` to override the default when unset.
- `channels.msteams.groupAllowFrom` controls which senders can trigger in group chats/channels (falls back to `channels.msteams.allowFrom`).
- Set `groupPolicy: "open"` to allow any member (still mention‑gated by default).
- To allow **no channels**, set `channels.msteams.groupPolicy: "disabled"`.

Example:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**Teams + channel allowlist**

- Scope group/channel replies by listing teams and channels under `channels.msteams.teams`.
- Keys should use stable Teams conversation IDs from Teams links, not mutable display names.
- When `groupPolicy="allowlist"` and a teams allowlist is present, only listed teams/channels are accepted (mention‑gated).
- The configure wizard accepts `Team/Channel` entries and stores them for you.
- On startup, OpenClaw resolves team/channel and user allowlist names to IDs (when Graph permissions allow)
  and logs the mapping; unresolved team/channel names are kept as typed but ignored for routing by default unless `channels.msteams.dangerouslyAllowNameMatching: true` is enabled.

Example:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

<details>
<summary><strong>Manual setup (without the Teams CLI)</strong></summary>

If you can't use the Teams CLI, you can set up the bot manually through the Azure Portal.

### How it works

1. Ensure the Microsoft Teams plugin is available (bundled in current releases).
2. Create an **Azure Bot** (App ID + secret + tenant ID).
3. Build a **Teams app package** that references the bot and includes the RSC permissions below.
4. Upload/install the Teams app into a team (or personal scope for DMs).
5. Configure `msteams` in `~/.openclaw/openclaw.json` (or env vars) and start the gateway.
6. The gateway listens for Bot Framework webhook traffic on `/api/messages` by default.

### Step 1: Create Azure Bot

1. Go to [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. Fill in the **Basics** tab:

   | Field              | Value                                                    |
   | ------------------ | -------------------------------------------------------- |
   | **Bot handle**     | Your bot name, e.g., `openclaw-msteams` (must be unique) |
   | **Subscription**   | Select your Azure subscription                           |
   | **Resource group** | Create new or use existing                               |
   | **Pricing tier**   | **Free** for dev/testing                                 |
   | **Type of App**    | **Single Tenant** (recommended - see note below)         |
   | **Creation type**  | **Create new Microsoft App ID**                          |

<Warning>
Creation of new multi-tenant bots was deprecated after 2025-07-31. Use **Single Tenant** for new bots.
</Warning>

3. Click **Review + create** → **Create** (wait ~1-2 minutes)

### Step 2: Get Credentials

1. Go to your Azure Bot resource → **Configuration**
2. Copy **Microsoft App ID** → this is your `appId`
3. Click **Manage Password** → go to the App Registration
4. Under **Certificates & secrets** → **New client secret** → copy the **Value** → this is your `appPassword`
5. Go to **Overview** → copy **Directory (tenant) ID** → this is your `tenantId`

### Step 3: Configure Messaging Endpoint

1. In Azure Bot → **Configuration**
2. Set **Messaging endpoint** to your webhook URL:
   - Production: `https://your-domain.com/api/messages`
   - Local dev: Use a tunnel (see [Local Development](#local-development-tunneling) below)

### Step 4: Enable Teams Channel

1. In Azure Bot → **Channels**
2. Click **Microsoft Teams** → Configure → Save
3. Accept the Terms of Service

### Step 5: Build Teams App Manifest

- Include a `bot` entry with `botId = <App ID>`.
- Scopes: `personal`, `team`, `groupChat`.
- `supportsFiles: true` (required for personal scope file handling).
- Add RSC permissions (see [RSC Permissions](#current-teams-rsc-permissions-manifest)).
- Create icons: `outline.png` (32x32) and `color.png` (192x192).
- Zip all three files together: `manifest.json`, `outline.png`, `color.png`.

### Step 6: Configure OpenClaw

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Environment variables: `MSTEAMS_APP_ID`, `MSTEAMS_APP_PASSWORD`, `MSTEAMS_TENANT_ID`.

### Step 7: Run the Gateway

The Teams channel starts automatically when the plugin is available and `msteams` config exists with credentials.

</details>

## Federated authentication (certificate plus managed identity)

> Added in 2026.4.11

For production deployments, OpenClaw supports **federated authentication** as a more secure alternative to client secrets. Two methods are available:

### Option A: Certificate-based authentication

Use a PEM certificate registered with your Entra ID app registration.

**Setup:**

1. Generate or obtain a certificate (PEM format with private key).
2. In Entra ID → App Registration → **Certificates & secrets** → **Certificates** → Upload the public certificate.

**Config:**

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      tenantId: "<TENANT_ID>",
      authType: "federated",
      certificatePath: "/path/to/cert.pem",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

**Env vars:**

- `MSTEAMS_AUTH_TYPE=federated`
- `MSTEAMS_CERTIFICATE_PATH=/path/to/cert.pem`

### Option B: Azure Managed Identity

Use Azure Managed Identity for passwordless authentication. This is ideal for deployments on Azure infrastructure (AKS, App Service, Azure VMs) where a managed identity is available.

**How it works:**

1. The bot pod/VM has a managed identity (system-assigned or user-assigned).
2. A **federated identity credential** links the managed identity to the Entra ID app registration.
3. At runtime, OpenClaw uses `@azure/identity` to acquire tokens from the Azure IMDS endpoint (`169.254.169.254`).
4. The token is passed to the Teams SDK for bot authentication.

**Prerequisites:**

- Azure infrastructure with managed identity enabled (AKS workload identity, App Service, VM)
- Federated identity credential created on the Entra ID app registration
- Network access to IMDS (`169.254.169.254:80`) from the pod/VM

**Config (system-assigned managed identity):**

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      tenantId: "<TENANT_ID>",
      authType: "federated",
      useManagedIdentity: true,
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

**Config (user-assigned managed identity):**

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      tenantId: "<TENANT_ID>",
      authType: "federated",
      useManagedIdentity: true,
      managedIdentityClientId: "<MI_CLIENT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

**Env vars:**

- `MSTEAMS_AUTH_TYPE=federated`
- `MSTEAMS_USE_MANAGED_IDENTITY=true`
- `MSTEAMS_MANAGED_IDENTITY_CLIENT_ID=<client-id>` (only for user-assigned)

### AKS Workload Identity Setup

For AKS deployments using workload identity:

1. **Enable workload identity** on your AKS cluster.
2. **Create a federated identity credential** on the Entra ID app registration:

   ```bash
   az ad app federated-credential create --id <APP_OBJECT_ID> --parameters '{
     "name": "my-bot-workload-identity",
     "issuer": "<AKS_OIDC_ISSUER_URL>",
     "subject": "system:serviceaccount:<NAMESPACE>:<SERVICE_ACCOUNT>",
     "audiences": ["api://AzureADTokenExchange"]
   }'
   ```

3. **Annotate the Kubernetes service account** with the app client ID:

   ```yaml
   apiVersion: v1
   kind: ServiceAccount
   metadata:
     name: my-bot-sa
     annotations:
       azure.workload.identity/client-id: "<APP_CLIENT_ID>"
   ```

4. **Label the pod** for workload identity injection:

   ```yaml
   metadata:
     labels:
       azure.workload.identity/use: "true"
   ```

5. **Ensure network access** to IMDS (`169.254.169.254`) — if using NetworkPolicy, add an egress rule allowing traffic to `169.254.169.254/32` on port 80.

### Auth type comparison

| Method               | Config                                         | Pros                               | Cons                                  |
| -------------------- | ---------------------------------------------- | ---------------------------------- | ------------------------------------- |
| **Client secret**    | `appPassword`                                  | Simple setup                       | Secret rotation required, less secure |
| **Certificate**      | `authType: "federated"` + `certificatePath`    | No shared secret over network      | Certificate management overhead       |
| **Managed Identity** | `authType: "federated"` + `useManagedIdentity` | Passwordless, no secrets to manage | Azure infrastructure required         |

**Default behavior:** When `authType` is not set, OpenClaw defaults to client secret authentication. Existing configurations continue to work without changes.

## Local development (tunneling)

Teams can't reach `localhost`. Use a persistent dev tunnel so your URL stays the same across sessions:

```bash
# One-time setup:
devtunnel create my-openclaw-bot --allow-anonymous
devtunnel port create my-openclaw-bot -p 3978 --protocol auto

# Each dev session:
devtunnel host my-openclaw-bot
```

Alternatives: `ngrok http 3978` or `tailscale funnel 3978` (URLs may change each session).

If your tunnel URL changes, update the endpoint:

```bash
teams app update <teamsAppId> --endpoint "https://<new-url>/api/messages"
```

## Testing the Bot

**Run diagnostics:**

```bash
teams app doctor <teamsAppId>
```

Checks bot registration, AAD app, manifest, and SSO configuration in one pass.

**Send a test message:**

1. Install the Teams app (use the install link from `teams app get <id> --install-link`)
2. Find the bot in Teams and send a DM
3. Check gateway logs for incoming activity

## Environment variables

All config keys can be set via environment variables instead:

- `MSTEAMS_APP_ID`
- `MSTEAMS_APP_PASSWORD`
- `MSTEAMS_TENANT_ID`
- `MSTEAMS_AUTH_TYPE` (optional: `"secret"` or `"federated"`)
- `MSTEAMS_CERTIFICATE_PATH` (federated + certificate)
- `MSTEAMS_CERTIFICATE_THUMBPRINT` (optional, not required for auth)
- `MSTEAMS_USE_MANAGED_IDENTITY` (federated + managed identity)
- `MSTEAMS_MANAGED_IDENTITY_CLIENT_ID` (user-assigned MI only)

## Member info action

OpenClaw exposes a Graph-backed `member-info` action for Microsoft Teams so agents and automations can resolve channel member details (display name, email, role) directly from Microsoft Graph.

Requirements:

- `Member.Read.Group` RSC permission (already in the recommended manifest)
- For cross-team lookups: `User.Read.All` Graph Application permission with admin consent

The action is gated by `channels.msteams.actions.memberInfo` (default: enabled when Graph credentials are available).

## History context

- `channels.msteams.historyLimit` controls how many recent channel/group messages are wrapped into the prompt.
- Falls back to `messages.groupChat.historyLimit`. Set `0` to disable (default 50).
- Fetched thread history is filtered by sender allowlists (`allowFrom` / `groupAllowFrom`), so thread context seeding only includes messages from allowed senders.
- Quoted attachment context (`ReplyTo*` derived from Teams reply HTML) is currently passed as received.
- In other words, allowlists gate who can trigger the agent; only specific supplemental context paths are filtered today.
- DM history can be limited with `channels.msteams.dmHistoryLimit` (user turns). Per-user overrides: `channels.msteams.dms["<user_id>"].historyLimit`.

## Current Teams RSC permissions (manifest)

These are the **existing resourceSpecific permissions** in our Teams app manifest. They only apply inside the team/chat where the app is installed.

**For channels (team scope):**

- `ChannelMessage.Read.Group` (Application) - receive all channel messages without @mention
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**For group chats:**

- `ChatMessage.Read.Chat` (Application) - receive all group chat messages without @mention

To add RSC permissions via the Teams CLI:

```bash
teams app rsc add <teamsAppId> ChannelMessage.Read.Group --type Application
```

## Example Teams manifest (redacted)

Minimal, valid example with the required fields. Replace IDs and URLs.

```json5
{
  $schema: "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  manifestVersion: "1.23",
  version: "1.0.0",
  id: "00000000-0000-0000-0000-000000000000",
  name: { short: "OpenClaw" },
  developer: {
    name: "Your Org",
    websiteUrl: "https://example.com",
    privacyUrl: "https://example.com/privacy",
    termsOfUseUrl: "https://example.com/terms",
  },
  description: { short: "OpenClaw in Teams", full: "OpenClaw in Teams" },
  icons: { outline: "outline.png", color: "color.png" },
  accentColor: "#5B6DEF",
  bots: [
    {
      botId: "11111111-1111-1111-1111-111111111111",
      scopes: ["personal", "team", "groupChat"],
      isNotificationOnly: false,
      supportsCalling: false,
      supportsVideo: false,
      supportsFiles: true,
    },
  ],
  webApplicationInfo: {
    id: "11111111-1111-1111-1111-111111111111",
  },
  authorization: {
    permissions: {
      resourceSpecific: [
        { name: "ChannelMessage.Read.Group", type: "Application" },
        { name: "ChannelMessage.Send.Group", type: "Application" },
        { name: "Member.Read.Group", type: "Application" },
        { name: "Owner.Read.Group", type: "Application" },
        { name: "ChannelSettings.Read.Group", type: "Application" },
        { name: "TeamMember.Read.Group", type: "Application" },
        { name: "TeamSettings.Read.Group", type: "Application" },
        { name: "ChatMessage.Read.Chat", type: "Application" },
      ],
    },
  },
}
```

### Manifest caveats (must-have fields)

- `bots[].botId` **must** match the Azure Bot App ID.
- `webApplicationInfo.id` **must** match the Azure Bot App ID.
- `bots[].scopes` must include the surfaces you plan to use (`personal`, `team`, `groupChat`).
- `bots[].supportsFiles: true` is required for file handling in personal scope.
- `authorization.permissions.resourceSpecific` must include channel read/send if you want channel traffic.

### Updating an existing app

To update an already-installed Teams app (e.g., to add RSC permissions):

```bash
# Download, edit, and re-upload the manifest
teams app manifest download <teamsAppId> manifest.json
# Edit manifest.json locally...
teams app manifest upload manifest.json <teamsAppId>
# Version is auto-bumped if content changed
```

After updating, reinstall the app in each team for new permissions to take effect, and **fully quit and relaunch Teams** (not just close the window) to clear cached app metadata.

<details>
<summary>Manual manifest update (without CLI)</summary>

1. Update your `manifest.json` with the new settings
2. **Increment the `version` field** (e.g., `1.0.0` → `1.1.0`)
3. **Re-zip** the manifest with icons (`manifest.json`, `outline.png`, `color.png`)
4. Upload the new zip:
   - **Teams Admin Center:** Teams apps → Manage apps → find your app → Upload new version
   - **Sideload:** In Teams → Apps → Manage your apps → Upload a custom app

</details>

## Capabilities: RSC only vs Graph

### With **Teams RSC only** (app installed, no Graph API permissions)

Works:

- Read channel message **text** content.
- Send channel message **text** content.
- Receive **personal (DM)** file attachments.

Does NOT work:

- Channel/group **image or file contents** (payload only includes HTML stub).
- Downloading attachments stored in SharePoint/OneDrive.
- Reading message history (beyond the live webhook event).

### With **Teams RSC + Microsoft Graph Application permissions**

Adds:

- Downloading hosted contents (images pasted into messages).
- Downloading file attachments stored in SharePoint/OneDrive.
- Reading channel/chat message history via Graph.

### RSC vs Graph API

| Capability              | RSC Permissions      | Graph API                           |
| ----------------------- | -------------------- | ----------------------------------- |
| **Real-time messages**  | Yes (via webhook)    | No (polling only)                   |
| **Historical messages** | No                   | Yes (can query history)             |
| **Setup complexity**    | App manifest only    | Requires admin consent + token flow |
| **Works offline**       | No (must be running) | Yes (query anytime)                 |

**Bottom line:** RSC is for real-time listening; Graph API is for historical access. For catching up on missed messages while offline, you need Graph API with `ChannelMessage.Read.All` (requires admin consent).

## Graph-enabled media + history (required for channels)

If you need images/files in **channels** or want to fetch **message history**, you must enable Microsoft Graph permissions and grant admin consent.

1. In Entra ID (Azure AD) **App Registration**, add Microsoft Graph **Application permissions**:
   - `ChannelMessage.Read.All` (channel attachments + history)
   - `Chat.Read.All` or `ChatMessage.Read.All` (group chats)
2. **Grant admin consent** for the tenant.
3. Bump the Teams app **manifest version**, re-upload, and **reinstall the app in Teams**.
4. **Fully quit and relaunch Teams** to clear cached app metadata.

**Additional permission for user mentions:** User @mentions work out of the box for users in the conversation. However, if you want to dynamically search and mention users who are **not in the current conversation**, add `User.Read.All` (Application) permission and grant admin consent.

## Known limitations

### Webhook timeouts

Teams delivers messages via HTTP webhook. If processing takes too long (e.g., slow LLM responses), you may see:

- Gateway timeouts
- Teams retrying the message (causing duplicates)
- Dropped replies

OpenClaw handles this by returning quickly and sending replies proactively, but very slow responses may still cause issues.

### Formatting

Teams markdown is more limited than Slack or Discord:

- Basic formatting works: **bold**, _italic_, `code`, links
- Complex markdown (tables, nested lists) may not render correctly
- Adaptive Cards are supported for polls and semantic presentation sends (see below)

## Configuration

Key settings (see `/gateway/configuration` for shared channel patterns):

- `channels.msteams.enabled`: enable/disable the channel.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: bot credentials.
- `channels.msteams.webhook.port` (default `3978`)
- `channels.msteams.webhook.path` (default `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing)
- `channels.msteams.allowFrom`: DM allowlist (AAD object IDs recommended). The wizard resolves names to IDs during setup when Graph access is available.
- `channels.msteams.dangerouslyAllowNameMatching`: break-glass toggle to re-enable mutable UPN/display-name matching and direct team/channel name routing.
- `channels.msteams.textChunkLimit`: outbound text chunk size.
- `channels.msteams.chunkMode`: `length` (default) or `newline` to split on blank lines (paragraph boundaries) before length chunking.
- `channels.msteams.mediaAllowHosts`: allowlist for inbound attachment hosts (defaults to Microsoft/Teams domains).
- `channels.msteams.mediaAuthAllowHosts`: allowlist for attaching Authorization headers on media retries (defaults to Graph + Bot Framework hosts).
- `channels.msteams.requireMention`: require @mention in channels/groups (default true).
- `channels.msteams.replyStyle`: `thread | top-level` (see [Reply Style](#reply-style-threads-vs-posts)).
- `channels.msteams.teams.<teamId>.replyStyle`: per-team override.
- `channels.msteams.teams.<teamId>.requireMention`: per-team override.
- `channels.msteams.teams.<teamId>.tools`: default per-team tool policy overrides (`allow`/`deny`/`alsoAllow`) used when a channel override is missing.
- `channels.msteams.teams.<teamId>.toolsBySender`: default per-team per-sender tool policy overrides (`"*"` wildcard supported).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: per-channel override.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: per-channel override.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: per-channel tool policy overrides (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: per-channel per-sender tool policy overrides (`"*"` wildcard supported).
- `toolsBySender` keys should use explicit prefixes:
  `id:`, `e164:`, `username:`, `name:` (legacy unprefixed keys still map to `id:` only).
- `channels.msteams.actions.memberInfo`: enable or disable the Graph-backed member info action (default: enabled when Graph credentials are available).
- `channels.msteams.authType`: authentication type — `"secret"` (default) or `"federated"`.
- `channels.msteams.certificatePath`: path to PEM certificate file (federated + certificate auth).
- `channels.msteams.certificateThumbprint`: certificate thumbprint (optional, not required for auth).
- `channels.msteams.useManagedIdentity`: enable managed identity auth (federated mode).
- `channels.msteams.managedIdentityClientId`: client ID for user-assigned managed identity.
- `channels.msteams.sharePointSiteId`: SharePoint site ID for file uploads in group chats/channels (see [Sending files in group chats](#sending-files-in-group-chats)).

## Routing & Sessions

- Session keys follow the standard agent format (see [/concepts/session](/concepts/session)):
  - Direct messages share the main session (`agent:<agentId>:<mainKey>`).
  - Channel/group messages use conversation id:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Reply style: threads vs posts

Teams recently introduced two channel UI styles over the same underlying data model:

| Style                    | Description                                               | Recommended `replyStyle` |
| ------------------------ | --------------------------------------------------------- | ------------------------ |
| **Posts** (classic)      | Messages appear as cards with threaded replies underneath | `thread` (default)       |
| **Threads** (Slack-like) | Messages flow linearly, more like Slack                   | `top-level`              |

**The problem:** The Teams API does not expose which UI style a channel uses. If you use the wrong `replyStyle`:

- `thread` in a Threads-style channel → replies appear nested awkwardly
- `top-level` in a Posts-style channel → replies appear as separate top-level posts instead of in-thread

**Solution:** Configure `replyStyle` per-channel based on how the channel is set up:

```json5
{
  channels: {
    msteams: {
      replyStyle: "thread",
      teams: {
        "19:abc...@thread.tacv2": {
          channels: {
            "19:xyz...@thread.tacv2": {
              replyStyle: "top-level",
            },
          },
        },
      },
    },
  },
}
```

## Attachments & Images

**Current limitations:**

- **DMs:** Images and file attachments work via Teams bot file APIs.
- **Channels/groups:** Attachments live in M365 storage (SharePoint/OneDrive). The webhook payload only includes an HTML stub, not the actual file bytes. **Graph API permissions are required** to download channel attachments.
- For explicit file-first sends, use `action=upload-file` with `media` / `filePath` / `path`; optional `message` becomes the accompanying text/comment, and `filename` overrides the uploaded name.

Without Graph permissions, channel messages with images will be received as text-only (the image content is not accessible to the bot).
By default, OpenClaw only downloads media from Microsoft/Teams hostnames. Override with `channels.msteams.mediaAllowHosts` (use `["*"]` to allow any host).
Authorization headers are only attached for hosts in `channels.msteams.mediaAuthAllowHosts` (defaults to Graph + Bot Framework hosts). Keep this list strict (avoid multi-tenant suffixes).

## Sending files in group chats

Bots can send files in DMs using the FileConsentCard flow (built-in). However, **sending files in group chats/channels** requires additional setup:

| Context                  | How files are sent                           | Setup needed                                    |
| ------------------------ | -------------------------------------------- | ----------------------------------------------- |
| **DMs**                  | FileConsentCard → user accepts → bot uploads | Works out of the box                            |
| **Group chats/channels** | Upload to SharePoint → share link            | Requires `sharePointSiteId` + Graph permissions |
| **Images (any context)** | Base64-encoded inline                        | Works out of the box                            |

### Why group chats need SharePoint

Bots don't have a personal OneDrive drive (the `/me/drive` Graph API endpoint doesn't work for application identities). To send files in group chats/channels, the bot uploads to a **SharePoint site** and creates a sharing link.

### Setup

1. **Add Graph API permissions** in Entra ID (Azure AD) → App Registration:
   - `Sites.ReadWrite.All` (Application) - upload files to SharePoint
   - `Chat.Read.All` (Application) - optional, enables per-user sharing links

2. **Grant admin consent** for the tenant.

3. **Get your SharePoint site ID:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **Configure OpenClaw:**

   ```json5
   {
     channels: {
       msteams: {
         // ... other config ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### Sharing behavior

| Permission                              | Sharing behavior                                          |
| --------------------------------------- | --------------------------------------------------------- |
| `Sites.ReadWrite.All` only              | Organization-wide sharing link (anyone in org can access) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | Per-user sharing link (only chat members can access)      |

Per-user sharing is more secure as only the chat participants can access the file. If `Chat.Read.All` permission is missing, the bot falls back to organization-wide sharing.

### Fallback behavior

| Scenario                                          | Result                                             |
| ------------------------------------------------- | -------------------------------------------------- |
| Group chat + file + `sharePointSiteId` configured | Upload to SharePoint, send sharing link            |
| Group chat + file + no `sharePointSiteId`         | Attempt OneDrive upload (may fail), send text only |
| Personal chat + file                              | FileConsentCard flow (works without SharePoint)    |
| Any context + image                               | Base64-encoded inline (works without SharePoint)   |

### Files stored location

Uploaded files are stored in a `/OpenClawShared/` folder in the configured SharePoint site's default document library.

## Polls (Adaptive Cards)

OpenClaw sends Teams polls as Adaptive Cards (there is no native Teams poll API).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- Votes are recorded by the gateway in `~/.openclaw/msteams-polls.json`.
- The gateway must stay online to record votes.
- Polls do not auto-post result summaries yet (inspect the store file if needed).

## Presentation cards

Send semantic presentation payloads to Teams users or conversations using the `message` tool or CLI. OpenClaw renders them as Teams Adaptive Cards from the generic presentation contract.

The `presentation` parameter accepts semantic blocks. When `presentation` is provided, the message text is optional.

**Agent tool:**

```json5
{
  action: "send",
  channel: "msteams",
  target: "user:<id>",
  presentation: {
    title: "Hello",
    blocks: [{ type: "text", text: "Hello!" }],
  },
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --presentation '{"title":"Hello","blocks":[{"type":"text","text":"Hello!"}]}'
```

For target format details, see [Target formats](#target-formats) below.

## Target formats

MSTeams targets use prefixes to distinguish between users and conversations:

| Target type         | Format                           | Example                                             |
| ------------------- | -------------------------------- | --------------------------------------------------- |
| User (by ID)        | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`         |
| User (by name)      | `user:<display-name>`            | `user:John Smith` (requires Graph API)              |
| Group/channel       | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`            |
| Group/channel (raw) | `<conversation-id>`              | `19:abc123...@thread.tacv2` (if contains `@thread`) |

**CLI examples:**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send a presentation card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --presentation '{"title":"Hello","blocks":[{"type":"text","text":"Hello"}]}'
```

**Agent tool examples:**

```json5
{
  action: "send",
  channel: "msteams",
  target: "user:John Smith",
  message: "Hello!",
}
```

```json5
{
  action: "send",
  channel: "msteams",
  target: "conversation:19:abc...@thread.tacv2",
  presentation: {
    title: "Hello",
    blocks: [{ type: "text", text: "Hello" }],
  },
}
```

<Note>
Without the `user:` prefix, names default to group or team resolution. Always use `user:` when targeting people by display name.
</Note>

## Proactive messaging

- Proactive messages are only possible **after** a user has interacted, because we store conversation references at that point.
- See `/gateway/configuration` for `dmPolicy` and allowlist gating.

## Team and Channel IDs (Common Gotcha)

The `groupId` query parameter in Teams URLs is **NOT** the team ID used for configuration. Extract IDs from the URL path instead:

**Team URL:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team conversation ID (URL-decode this)
```

**Channel URL:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**For config:**

- Team key = path segment after `/team/` (URL-decoded, e.g., `19:Bk4j...@thread.tacv2`; older tenants may show `@thread.skype`, which is also valid)
- Channel key = path segment after `/channel/` (URL-decoded)
- **Ignore** the `groupId` query parameter for OpenClaw routing. It is the Microsoft Entra group ID, not the Bot Framework conversation ID used in incoming Teams activities.

## Private channels

Bots have limited support in private channels:

| Feature                      | Standard Channels | Private Channels       |
| ---------------------------- | ----------------- | ---------------------- |
| Bot installation             | Yes               | Limited                |
| Real-time messages (webhook) | Yes               | May not work           |
| RSC permissions              | Yes               | May behave differently |
| @mentions                    | Yes               | If bot is accessible   |
| Graph API history            | Yes               | Yes (with permissions) |

**Workarounds if private channels don't work:**

1. Use standard channels for bot interactions
2. Use DMs - users can always message the bot directly
3. Use Graph API for historical access (requires `ChannelMessage.Read.All`)

## Troubleshooting

### Common issues

- **Images not showing in channels:** Graph permissions or admin consent missing. Reinstall the Teams app and fully quit/reopen Teams.
- **No responses in channel:** mentions are required by default; set `channels.msteams.requireMention=false` or configure per team/channel.
- **Version mismatch (Teams still shows old manifest):** remove + re-add the app and fully quit Teams to refresh.
- **401 Unauthorized from webhook:** Expected when testing manually without Azure JWT - means endpoint is reachable but auth failed. Use Azure Web Chat to test properly.

### Manifest upload errors

- **"Icon file cannot be empty":** The manifest references icon files that are 0 bytes. Create valid PNG icons (32x32 for `outline.png`, 192x192 for `color.png`).
- **"webApplicationInfo.Id already in use":** The app is still installed in another team/chat. Find and uninstall it first, or wait 5-10 minutes for propagation.
- **"Something went wrong" on upload:** Upload via [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) instead, open browser DevTools (F12) → Network tab, and check the response body for the actual error.
- **Sideload failing:** Try "Upload an app to your org's app catalog" instead of "Upload a custom app" - this often bypasses sideload restrictions.

### RSC permissions not working

1. Verify `webApplicationInfo.id` matches your bot's App ID exactly
2. Re-upload the app and reinstall in the team/chat
3. Check if your org admin has blocked RSC permissions
4. Confirm you're using the right scope: `ChannelMessage.Read.Group` for teams, `ChatMessage.Read.Chat` for group chats

## References

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Azure Bot setup guide
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) - create/manage Teams apps
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Receive channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (channel/group requires Graph)
- [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
- [@microsoft/teams.cli](https://www.npmjs.com/package/@microsoft/teams.cli) - Teams CLI for bot management

## Related

- [Channels Overview](/channels) — all supported channels
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
