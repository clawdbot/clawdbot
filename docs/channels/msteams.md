---
summary: "Microsoft Teams bot support status, capabilities, and configuration"
read_when:
  - Working on Microsoft Teams channel features
title: "Microsoft Teams"
---

Status: text + DM attachments are supported; channel/group file sending requires `sharePointSiteId` + Graph permissions (see [Sending files in group chats](#sending-files-in-group-chats)). Polls are sent via Adaptive Cards. Message actions expose explicit `upload-file` for file-first sends.

## Bundled plugin

Microsoft Teams ships as a bundled plugin in current OpenClaw releases; no separate install is required in the normal packaged build.

On an older build or a custom install that excludes bundled Teams, install the npm package directly:

```bash
openclaw plugins install @openclaw/msteams
```

Use the bare package to follow the current official release tag. Pin an exact version only when you need a reproducible install.

Local checkout (running from a git repo):

```bash
openclaw plugins install ./path/to/local/msteams-plugin
```

Details: [Plugins](/tools/plugin)

## Quick setup

[`@microsoft/teams.cli`](https://www.npmjs.com/package/@microsoft/teams.cli) handles bot registration, manifest creation, and credential generation in one command.

**1. Install and log in**

```bash
npm install -g @microsoft/teams.cli@preview
teams login
teams status   # verify you're logged in and see your tenant info
```

<Note>
The Teams CLI is currently in preview. Commands and flags may change between releases.
</Note>

**2. Start a tunnel** (Teams cannot reach localhost)

Install and authenticate the devtunnel CLI if needed ([getting started guide](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started)).

```bash
# One-time setup (persistent URL across sessions):
devtunnel create my-openclaw-bot --allow-anonymous
devtunnel port create my-openclaw-bot -p 3978 --protocol auto

# Each dev session:
devtunnel host my-openclaw-bot
# Your endpoint: https://<tunnel-id>.devtunnels.ms/api/messages
```

<Note>
`--allow-anonymous` is required because Teams cannot authenticate with devtunnels. Each incoming bot request is still validated by the Teams SDK.
</Note>

Alternatives: `ngrok http 3978` or `tailscale funnel 3978` (URLs may change each session).

**3. Create the app**

```bash
teams app create \
  --name "OpenClaw" \
  --endpoint "https://<your-tunnel-url>/api/messages"
```

This creates an Entra ID (Azure AD) application, generates a client secret, builds and uploads a Teams app manifest (with icons), and registers a Teams-managed bot (no Azure subscription needed). The output includes `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID`, and a **Teams App ID**; it also offers to install the app in Teams directly.

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

`teams app create` prompts you to install the app; select "Install in Teams". To get the install link later:

```bash
teams app get <teamsAppId> --install-link
```

**6. Verify everything works**

```bash
teams app doctor <teamsAppId>
```

Runs diagnostics across bot registration, AAD app config, manifest validity, and SSO setup.

For production, consider [federated authentication](#federated-authentication-certificate-plus-managed-identity) (certificate or managed identity) instead of client secrets.

<Note>
Group chats are blocked by default (`channels.msteams.groupPolicy: "allowlist"`). To allow group replies, set `channels.msteams.groupAllowFrom`, or use `groupPolicy: "open"` to allow any member (mention-gated).
</Note>

## Goals

- Talk to OpenClaw via Teams DMs, group chats, or channels.
- Keep routing deterministic: replies always go back to the channel they arrived on.
- Default to safe channel behavior (mentions required unless configured otherwise).

## Config writes

By default, Microsoft Teams can write config updates triggered by `/config set|unset` (requires `commands.config: true`).

Disable with:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## Access control (DMs + groups)

**DM access**

- Default: `channels.msteams.dmPolicy = "pairing"`. Unknown senders are ignored until approved.
- `channels.msteams.allowFrom` should use stable AAD object IDs or static sender access groups such as `accessGroup:core-team`.
- Do not rely on UPN/display-name matching for allowlists; they can change. OpenClaw disables direct name matching by default; opt in with `channels.msteams.dangerouslyAllowNameMatching: true`.
- The wizard can resolve names to IDs via Microsoft Graph when credentials allow.

**Group access**

- Default: `channels.msteams.groupPolicy = "allowlist"` (blocked unless you add `groupAllowFrom`). `channels.defaults.groupPolicy` can override the shared default when `channels.msteams.groupPolicy` is unset.
- `channels.msteams.groupAllowFrom` controls which senders or static sender access groups can trigger in group chats/channels (falls back to `channels.msteams.allowFrom`).
- Set `groupPolicy: "open"` to allow any member (still mention-gated by default).
- To block **all** channels, set `channels.msteams.groupPolicy: "disabled"`.

Example:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["00000000-0000-0000-0000-000000000000", "accessGroup:core-team"],
    },
  },
}
```

**Team + channel allowlist**

- Scope group/channel replies by listing teams and channels under `channels.msteams.teams`.
- Use stable Teams conversation IDs from Teams links as keys, not mutable display names (see [Team and Channel IDs](#team-and-channel-ids-common-gotcha)).
- When `groupPolicy="allowlist"` and a teams allowlist is present, only listed teams/channels are accepted (mention-gated).
- The configure wizard accepts `Team/Channel` entries and stores them for you.
- On startup, OpenClaw resolves team/channel and user allowlist names to IDs (when Graph permissions allow) and logs the mapping. Unresolved names are kept as typed but ignored for routing unless `channels.msteams.dangerouslyAllowNameMatching: true` is set.

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

### How it works

1. Ensure the Microsoft Teams plugin is available (bundled in current releases).
2. Create an **Azure Bot** (App ID + secret + tenant ID).
3. Build a **Teams app package** referencing the bot, including the RSC permissions below.
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
   | **Type of App**    | **Single Tenant** (recommended; see note below)          |
   | **Creation type**  | **Create new Microsoft App ID**                          |

<Warning>
Creation of new multi-tenant bots was deprecated after 2025-07-31. Use **Single Tenant** for new bots.
</Warning>

3. Click **Review + create** then **Create** (~1-2 minutes).

### Step 2: Get credentials

1. Azure Bot resource → **Configuration** → copy **Microsoft App ID** (your `appId`).
2. **Manage Password** → App Registration → **Certificates & secrets** → **New client secret** → copy the **Value** (your `appPassword`).
3. **Overview** → copy **Directory (tenant) ID** (your `tenantId`).

### Step 3: Configure messaging endpoint

1. Azure Bot → **Configuration**.
2. Set **Messaging endpoint**:
   - Production: `https://your-domain.com/api/messages`
   - Local dev: use a tunnel (see [Local development](#local-development-tunneling))

### Step 4: Enable Teams channel

1. Azure Bot → **Channels**.
2. Click **Microsoft Teams** → Configure → Save.
3. Accept the Terms of Service.

### Step 5: Build Teams app manifest

- Include a `bot` entry with `botId = <App ID>`.
- Scopes: `personal`, `team`, `groupChat`.
- `supportsFiles: true` (required for personal-scope file handling).
- Add RSC permissions (see [RSC permissions](#current-teams-rsc-permissions-manifest)).
- Create icons: `outline.png` (32x32) and `color.png` (192x192).
- Zip `manifest.json`, `outline.png`, and `color.png` together.

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

### Step 7: Run the gateway

The Teams channel starts automatically when the plugin is available and `msteams` config has credentials.

</details>

## Federated authentication (certificate plus managed identity)

For production, OpenClaw supports **federated authentication** as an alternative to client secrets, via `channels.msteams.authType: "federated"`. Two methods:

### Option A: Certificate-based authentication

Use a PEM certificate registered with your Entra ID app registration.

**Setup:**

1. Generate or obtain a certificate (PEM format with private key).
2. Entra ID → App Registration → **Certificates & secrets** → **Certificates** → upload the public certificate.

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

Use Azure Managed Identity for passwordless authentication on Azure infrastructure (AKS, App Service, Azure VMs).

**How it works:**

1. The bot pod/VM has a managed identity (system- or user-assigned).
2. A federated identity credential links the managed identity to the Entra ID app registration.
3. At runtime, OpenClaw uses `@azure/identity` to acquire tokens from the Azure IMDS endpoint.
4. The token is passed to the Teams SDK for bot authentication.

**Prerequisites:**

- Azure infrastructure with managed identity enabled (AKS workload identity, App Service, VM).
- Federated identity credential created on the Entra ID app registration.
- Network access to IMDS (`169.254.169.254:80`) from the pod/VM.

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

**Config (user-assigned managed identity):** add `managedIdentityClientId: "<MI_CLIENT_ID>"` to the block above.

**Env vars:**

- `MSTEAMS_AUTH_TYPE=federated`
- `MSTEAMS_USE_MANAGED_IDENTITY=true`
- `MSTEAMS_MANAGED_IDENTITY_CLIENT_ID=<client-id>` (user-assigned only)

### AKS Workload Identity setup

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

5. **Allow network access** to IMDS (`169.254.169.254`): if using NetworkPolicy, add an egress rule for `169.254.169.254/32` on port 80.

### Auth type comparison

| Method               | Config                                         | Pros                               | Cons                                  |
| -------------------- | ---------------------------------------------- | ---------------------------------- | ------------------------------------- |
| **Client secret**    | `appPassword`                                  | Simple setup                       | Secret rotation required, less secure |
| **Certificate**      | `authType: "federated"` + `certificatePath`    | No shared secret over network      | Certificate management overhead       |
| **Managed Identity** | `authType: "federated"` + `useManagedIdentity` | Passwordless, no secrets to manage | Azure infrastructure required         |

`certificateThumbprint` can be set alongside `certificatePath` but is not read by the auth path today; it is accepted for forward compatibility only.

**Default:** when `authType` is unset, OpenClaw uses client-secret authentication (`appPassword`). Existing configs keep working unchanged.

## Local development (tunneling)

Teams cannot reach `localhost`. Use a persistent dev tunnel so the URL stays stable across sessions:

```bash
# One-time setup:
devtunnel create my-openclaw-bot --allow-anonymous
devtunnel port create my-openclaw-bot -p 3978 --protocol auto

# Each dev session:
devtunnel host my-openclaw-bot
```

Alternatives: `ngrok http 3978` or `tailscale funnel 3978` (URLs may change each session).

If the tunnel URL changes, update the endpoint:

```bash
teams app update <teamsAppId> --endpoint "https://<new-url>/api/messages"
```

## Testing the bot

**Run diagnostics:**

```bash
teams app doctor <teamsAppId>
```

Checks bot registration, AAD app, manifest, and SSO configuration in one pass.

**Send a test message:**

1. Install the Teams app (install link from `teams app get <id> --install-link`).
2. Find the bot in Teams and send a DM.
3. Check gateway logs for incoming activity.

## Environment variables

These auth-related config keys can be set via environment variables instead of `openclaw.json` (other config keys, such as `groupPolicy` or `historyLimit`, are config-only):

| Env var                              | Config key                | Notes                               |
| ------------------------------------ | ------------------------- | ----------------------------------- |
| `MSTEAMS_APP_ID`                     | `appId`                   |                                     |
| `MSTEAMS_APP_PASSWORD`               | `appPassword`             |                                     |
| `MSTEAMS_TENANT_ID`                  | `tenantId`                |                                     |
| `MSTEAMS_AUTH_TYPE`                  | `authType`                | `"secret"` or `"federated"`         |
| `MSTEAMS_CERTIFICATE_PATH`           | `certificatePath`         | federated + certificate             |
| `MSTEAMS_CERTIFICATE_THUMBPRINT`     | `certificateThumbprint`   | accepted, not required for auth     |
| `MSTEAMS_USE_MANAGED_IDENTITY`       | `useManagedIdentity`      | federated + managed identity        |
| `MSTEAMS_MANAGED_IDENTITY_CLIENT_ID` | `managedIdentityClientId` | user-assigned managed identity only |

## Member info action

OpenClaw exposes a Graph-backed `member-info` action for Microsoft Teams so agents and automations can resolve verified roster details for a configured conversation.

Requirements:

- `ChannelSettings.Read.Group` and `TeamMember.Read.Group` RSC permissions (already in the recommended manifest).

The action is available whenever Graph credentials are configured; there is no separate `channels.msteams.actions.memberInfo` toggle.
Standard-channel lookups return the matching team-roster identity, display name, email, and roles.
In the current DM or group chat, the action can return the trusted sender's stable user ID.
Private/shared-channel and non-current chat member lookups require additional roster permissions
and are rejected by the default permission baseline.

## History context

- `channels.msteams.historyLimit` controls how many recent channel/group messages are wrapped into the prompt. Falls back to `messages.groupChat.historyLimit`, then defaults to 50. Set `0` to disable.
- Fetched thread history is filtered by sender allowlists (`allowFrom` / `groupAllowFrom`), so thread context seeding only includes messages from allowed senders.
- Quoted attachment context (parsed from the Skype Reply-schema HTML in a reply's own attachments) is passed through unfiltered; only thread-history seeding applies the sender-allowlist filter today.
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

Add RSC permissions via the Teams CLI:

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
- `authorization.permissions.resourceSpecific` must include channel read/send for channel traffic.

### Updating an existing app

```bash
# Download, edit, and re-upload the manifest
teams app manifest download <teamsAppId> manifest.json
# Edit manifest.json locally...
teams app manifest upload manifest.json <teamsAppId>
# Version is auto-bumped if content changed
```

After updating, reinstall the app in each team, and **fully quit and relaunch Teams** (not just close the window) to clear cached app metadata.

<details>
<summary>Manual manifest update (without CLI)</summary>

1. Update `manifest.json` with the new settings.
2. **Increment the `version` field** (e.g., `1.0.0` → `1.1.0`).
3. **Re-zip** the manifest with icons (`manifest.json`, `outline.png`, `color.png`).
4. Upload the new zip:
   - **Teams Admin Center:** Teams apps → Manage apps → find your app → Upload new version.
   - **Sideload:** Teams → Apps → Manage your apps → Upload a custom app.

</details>

## Capabilities: RSC only vs Graph

### With **Teams RSC only** (app installed, no Graph API permissions)

Works:

- Read channel message **text** content.
- Send channel message **text** content.
- Receive **personal (DM)** file attachments.

Does NOT work:

- Channel/group **image or file contents** (payload only includes an HTML stub).
- Downloading attachments stored in SharePoint/OneDrive.
- Reading message history beyond the live webhook event.

### With **Teams RSC + Microsoft Graph Application permissions**

Adds:

- Downloading hosted content (images pasted into messages).
- Downloading file attachments stored in SharePoint/OneDrive.
- Reading channel/chat message history via Graph.

### RSC vs Graph API

| Capability              | RSC permissions      | Graph API                           |
| ----------------------- | -------------------- | ----------------------------------- |
| **Real-time messages**  | Yes (via webhook)    | No (polling only)                   |
| **Historical messages** | No                   | Yes (can query history)             |
| **Setup complexity**    | App manifest only    | Requires admin consent + token flow |
| **Works offline**       | No (must be running) | Yes (query anytime)                 |

**Bottom line:** RSC is for real-time listening; Graph API is for historical access. To catch up on missed messages while offline, you need Graph API with `ChannelMessage.Read.All` (requires admin consent).

## Graph-enabled media + history

Enable only the Microsoft Graph application permissions needed for the Teams scopes and data you use:

1. Entra ID (Azure AD) **App Registration** → add Graph **Application permissions**:
   - `ChannelMessage.Read.All` for channel attachments and channel history.
   - `Chat.Read.All` for group-chat attachments and group-chat history.
   - `Files.Read.All` when attachment bytes must be downloaded from SharePoint/OneDrive storage; history-only setups do not need it.
2. **Grant admin consent** for the tenant.
3. Bump the Teams app **manifest version**, re-upload, and **reinstall the app in Teams**.
4. **Fully quit and relaunch Teams** to clear cached app metadata.

### Channel/group file recovery (`graphMediaFallback`)

Teams can remove file markers from the HTML activity sent to a bot. In that case, the Bot Framework activity is indistinguishable from an ordinary HTML message; the complete attachment reference exists only on the Graph copy of the message.

Enable the fallback after granting the permissions above:

```json5
{
  channels: {
    msteams: {
      graphMediaFallback: true,
    },
  },
}
```

This applies to channels and group chats only. It adds one Graph message lookup whenever an HTML activity produced no directly downloadable media, including ordinary or mention-only messages. The default is `false` so existing installations do not gain extra Graph traffic or permission errors automatically.

**User mentions:** @mentions work out of the box for users already in the conversation. To dynamically search and mention users **not in the current conversation**, add `User.Read.All` (Application) permission and grant admin consent.

## Known limitations

### Webhook timeouts

Teams delivers messages via HTTP webhook. OpenClaw applies fixed HTTP server timeouts to that webhook listener: 30s inactivity, 30s total request, 15s to receive headers. Optional inbound media and context enrichment has a shared 10-second budget, but the Teams SDK still waits for the agent turn before returning the webhook response. If the full turn exceeds Teams' retry window, you may see:

- Teams retrying the message (causing duplicates).
- Dropped replies.

Replies are sent proactively once the agent responds, but slow agent runs can still surface retries or duplicates on the Teams side.

### Teams cloud and service URL support

This SDK-backed Teams path is live-validated for Microsoft Teams public cloud.

Inbound replies use the incoming Teams SDK turn context. Out-of-context proactive operations - sends, edits, deletes, cards, polls, file-consent messages, and queued long-running replies - use the stored conversation reference `serviceUrl`. Public cloud defaults to the Teams SDK public cloud environment and allows stored references on the public Teams Connector host: `https://smba.trafficmanager.net/`.

Public cloud is the default. You do not need to set `channels.msteams.cloud` or `channels.msteams.serviceUrl` for normal public-cloud bots.

For non-public Teams clouds, set `cloud` and the matching proactive boundary when Microsoft publishes one:

- `channels.msteams.cloud` selects the Teams SDK cloud preset for authentication, JWT validation, token services, and Graph scope.
- `channels.msteams.serviceUrl` selects the Bot Connector endpoint boundary used to validate stored conversation references before proactive sends, edits, deletes, cards, polls, file-consent messages, and queued long-running replies. It is required for USGov and DoD SDK clouds. For China/21Vianet, OpenClaw uses the SDK `China` preset and accepts stored/configured service URLs only on Azure China Bot Framework channel hosts.

Microsoft publishes the global proactive Bot Connector endpoints in the [Create the conversation](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages?tabs=dotnet#create-the-conversation) section of the Teams proactive messaging docs. Use the incoming activity's `serviceUrl` when available; otherwise use Microsoft's table below.

| Teams environment | OpenClaw config                                             | Proactive `serviceUrl`                             |
| ----------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| Public            | no cloud/serviceUrl config needed                           | `https://smba.trafficmanager.net/teams`            |
| GCC               | set `serviceUrl`; no separate Teams SDK cloud preset exists | `https://smba.infra.gcc.teams.microsoft.com/teams` |
| GCC High          | `cloud: "USGov"` + `serviceUrl`                             | `https://smba.infra.gov.teams.microsoft.us/teams`  |
| DoD               | `cloud: "USGovDoD"` + `serviceUrl`                          | `https://smba.infra.dod.teams.microsoft.us/teams`  |
| China/21Vianet    | `cloud: "China"`                                            | use the incoming activity's `serviceUrl`           |

Example for GCC, where Microsoft documents a separate proactive service URL but the Teams SDK exposes no separate GCC cloud preset:

```json
{
  "channels": {
    "msteams": {
      "serviceUrl": "https://smba.infra.gcc.teams.microsoft.com/teams"
    }
  }
}
```

Example for GCC High:

```json
{
  "channels": {
    "msteams": {
      "cloud": "USGov",
      "serviceUrl": "https://smba.infra.gov.teams.microsoft.us/teams"
    }
  }
}
```

`channels.msteams.serviceUrl` is restricted to supported Microsoft Teams Bot Connector hosts. When a service URL is configured, OpenClaw checks that the stored conversation `serviceUrl` uses the same host before proactive sends, edits, deletes, cards, polls, or queued long-running replies run. With the default public-cloud config, OpenClaw fails closed if a stored conversation points outside the public Teams Connector host. Receive a fresh message from the conversation after changing cloud/service URL settings so the stored conversation reference is current.

China/21Vianet has no separate global proactive `smba` URL in Microsoft's Teams proactive endpoint table. Configure `cloud: "China"` so the Teams SDK uses Azure China auth, token, and JWT endpoints. Proactive sends then require a stored conversation reference from an incoming China Teams activity, or an explicitly configured service URL, on the Azure China Bot Framework channel boundary (`*.botframework.azure.cn`). Graph-backed Teams helpers are disabled for `cloud: "China"` until OpenClaw routes Graph requests through the Azure China Graph endpoint.

### Formatting

Teams markdown is more limited than Slack or Discord:

- Basic formatting works: **bold**, _italic_, `code`, links.
- Complex markdown (tables, nested lists) may not render correctly.
- Adaptive Cards are supported for polls and semantic presentation sends (see below).

## Configuration

Key settings (see [/gateway/configuration](/gateway/configuration) for shared channel patterns):

- `channels.msteams.enabled`: enable/disable the channel.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: bot credentials.
- `channels.msteams.cloud`: Teams SDK cloud environment (`Public`, `USGov`, `USGovDoD`, or `China`; default `Public`). Set with `serviceUrl` for USGov/DoD SDK clouds; China uses the SDK preset and stored Azure China Bot Framework conversation references, with Graph-backed helpers disabled until Azure China Graph routing ships.
- `channels.msteams.serviceUrl`: Bot Connector service URL boundary for SDK proactive operations. Public cloud uses the SDK default; set for GCC (`https://smba.infra.gcc.teams.microsoft.com/teams`), GCC High, or DoD. China accepts Azure China Bot Framework channel hosts when the stored conversation reference comes from Teams operated by 21Vianet.
- `channels.msteams.webhook.port` (default `3978`).
- `channels.msteams.webhook.path` (default `/api/messages`).
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (default `pairing`).
- `channels.msteams.allowFrom`: DM allowlist (AAD object IDs recommended). The wizard resolves names to IDs during setup when Graph access is available.
- `channels.msteams.dangerouslyAllowNameMatching`: break-glass toggle to re-enable mutable UPN/display-name matching and direct team/channel name routing.
- `channels.msteams.textChunkLimit`: outbound text chunk size in characters (default `4000`, and hard-capped at `4000` regardless of a higher configured value).
- `channels.msteams.streaming.chunkMode`: `length` (default) or `newline` to split on blank lines (paragraph boundaries) before length chunking.
- `channels.msteams.mediaAllowHosts`: allowlist for inbound attachment hosts (defaults to Microsoft/Teams domains: Graph, SharePoint/OneDrive, Teams CDN, Bot Framework, Azure Media Services).
- `channels.msteams.mediaAuthAllowHosts`: allowlist for attaching Authorization headers on media retries (defaults to Graph + Bot Framework hosts).
- `channels.msteams.graphMediaFallback`: opt into Graph message lookups when channel/group HTML omits file markers (default `false`; see [Channel/group file recovery](#channelgroup-file-recovery-graphmediafallback)).
- `channels.msteams.mediaMaxMb`: per-channel media size limit override in MB. Falls back to `agents.defaults.mediaMaxMb` when unset.
- `channels.msteams.requireMention`: require @mention in channels/groups (default `true`).
- `channels.msteams.replyStyle`: `thread | top-level` (see [Reply style](#reply-style-threads-vs-posts)).
- `channels.msteams.teams.<teamId>.replyStyle`: per-team override.
- `channels.msteams.teams.<teamId>.requireMention`: per-team override.
- `channels.msteams.teams.<teamId>.tools`: default per-team tool policy overrides (`allow`/`deny`/`alsoAllow`) used when a channel override is missing.
- `channels.msteams.teams.<teamId>.toolsBySender`: default per-team per-sender tool policy overrides (`"*"` wildcard supported).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: per-channel override.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: per-channel override.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: per-channel tool policy overrides (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: per-channel per-sender tool policy overrides (`"*"` wildcard supported).
- `toolsBySender` keys should use explicit prefixes: `channel:`, `id:`, `e164:`, `username:`, `name:` (legacy unprefixed keys still map to `id:` only).
- `channels.msteams.authType`: authentication type - `"secret"` (default) or `"federated"`.
- `channels.msteams.certificatePath`: path to PEM certificate file (federated + certificate auth).
- `channels.msteams.certificateThumbprint`: certificate thumbprint; accepted, not required for auth.
- `channels.msteams.useManagedIdentity`: enable managed identity auth (federated mode).
- `channels.msteams.managedIdentityClientId`: client ID for user-assigned managed identity.
- `channels.msteams.sharePointSiteId`: SharePoint site ID for file uploads in group chats/channels (see [Sending files in group chats](#sending-files-in-group-chats)).
- `channels.msteams.welcomeCard`, `channels.msteams.groupWelcomeCard`, `channels.msteams.promptStarters`: welcome Adaptive Card shown on first DM/group contact, and its suggested prompt buttons.
- `channels.msteams.responsePrefix`: text prefixed to outbound replies.
- `channels.msteams.feedbackEnabled` (default `true`), `channels.msteams.feedbackReflection` (default `true`), `channels.msteams.feedbackReflectionCooldownMs`: thumbs-up/down feedback on replies and the negative-feedback reflection follow-up.
- `channels.msteams.sso`, `channels.msteams.delegatedAuth`: Bot Framework OAuth connection and delegated Graph scopes for SSO-backed flows; `sso.enabled: true` requires `sso.connectionName`.

## Routing and sessions

- Session keys follow the standard agent format (see [/concepts/session](/concepts/session)):
  - Direct messages share the main session (`agent:<agentId>:<mainKey>`).
  - Channel/group messages use conversation id:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Reply style: threads vs posts

Teams has two channel UI styles over the same underlying data model:

| Style                    | Description                                               | Recommended `replyStyle` |
| ------------------------ | --------------------------------------------------------- | ------------------------ |
| **Posts** (classic)      | Messages appear as cards with threaded replies underneath | `thread` (default)       |
| **Threads** (Slack-like) | Messages flow linearly, more like Slack                   | `top-level`              |

**The problem:** the Teams API does not expose which UI style a channel uses. If you use the wrong `replyStyle`:

- `thread` in a Threads-style channel → replies appear nested awkwardly.
- `top-level` in a Posts-style channel → replies appear as separate top-level posts instead of in-thread.

**Solution:** configure `replyStyle` per-channel based on how the channel is set up:

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

### Resolution precedence

When the bot sends a reply into a channel, `replyStyle` is resolved from the most specific override down to the default. The first non-`undefined` value wins:

1. **Per-channel** - `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`
2. **Per-team** - `channels.msteams.teams.<teamId>.replyStyle`
3. **Global** - `channels.msteams.replyStyle`
4. **Implicit default** - derived from `requireMention`:
   - `requireMention: true` → `thread`
   - `requireMention: false` → `top-level`

If you set `requireMention: false` globally without an explicit `replyStyle`, mentions in Posts-style channels surface as top-level posts even when the inbound was a thread reply. Pin `replyStyle: "thread"` at the global, team, or channel level to avoid surprises.

For proactive sends into a stored channel conversation (queued tool-call replies, long-running agents), the same team/channel resolution applies; group chats and personal (DM) conversations always resolve to `top-level` for proactive sends regardless of `replyStyle`.

### Thread context preservation

When `replyStyle: "thread"` is in effect and the bot was @mentioned from inside a channel thread, OpenClaw re-attaches the original thread root to the outbound conversation reference (`19:...@thread.tacv2;messageid=<root>`) so the reply lands inside the same thread. This holds for both live (in-turn) sends and proactive sends made after the Bot Framework turn context has expired (e.g., long-running agents, queued tool-call replies via `mcp__openclaw__message`).

The thread root is taken from the stored `threadId` on the conversation reference. Older stored references that predate `threadId` fall back to `activityId` (whatever inbound activity last seeded the conversation), so existing deployments keep working without a re-seed.

When `replyStyle: "top-level"` is in effect, channel-thread inbounds are intentionally answered as new top-level posts; no thread suffix is attached. This is correct for Threads-style channels; top-level posts where you expected threaded replies means `replyStyle` is set incorrectly for that channel.

## Attachments and images

**Current limitations:**

- **DMs:** images and file attachments work via Teams bot file APIs.
- **Channels/groups:** attachments live in M365 storage (SharePoint/OneDrive). The webhook payload only includes an HTML stub, not the actual file bytes. **Graph API permissions are required** to download channel attachments.
- For explicit file-first sends, use `action=upload-file` with `media` / `filePath` / `path`; optional `message` becomes the accompanying text/comment, and `filename` (or `title`) overrides the uploaded name.

Without Graph permissions, channel messages with images arrive as text-only (the image content is not accessible to the bot).
By default, OpenClaw only downloads media from Microsoft/Teams hostnames. Override with `channels.msteams.mediaAllowHosts` (use `["*"]` to allow any host).
Authorization headers are only attached for hosts in `channels.msteams.mediaAuthAllowHosts` (defaults to Graph + Bot Framework hosts). Keep this list strict (avoid multi-tenant suffixes).

## Sending files in group chats

Bots can send files in DMs using the built-in FileConsentCard flow. **Sending files in group chats/channels** requires additional setup:

| Context                  | How files are sent                           | Setup needed                                    |
| ------------------------ | -------------------------------------------- | ----------------------------------------------- |
| **DMs**                  | FileConsentCard → user accepts → bot uploads | Works out of the box                            |
| **Group chats/channels** | Upload to SharePoint → native file card      | Requires `sharePointSiteId` + Graph permissions |
| **Images (any context)** | Base64-encoded inline                        | Works out of the box                            |

### Why group chats need SharePoint

Bots use an application identity, while Microsoft Graph's `/me` resource [requires a signed-in user](https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0). To send files in group chats/channels, the bot uploads to a **SharePoint site** and creates a sharing link.

### Setup

1. **Add Graph API permissions** in Entra ID (Azure AD) → App Registration:
   - `Sites.ReadWrite.All` (Application) - upload files to SharePoint.
   - `ChatMember.Read.All` (Application) - least-privileged tenant-wide permission for group-chat file sends. `Chat.Read.All` also works and already covers this when group-chat history is enabled. As a per-chat alternative, use the `ChatMember.Read.Chat` [resource-specific consent permission](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent).
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

| Context and permission                                                  | Sharing behavior                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------------- |
| Channel + `Sites.ReadWrite.All`                                         | Organization-wide sharing link (anyone in org can access) |
| Group chat + `Sites.ReadWrite.All` + a supported chat-member read grant | Per-user sharing link (only chat members can access)      |
| Group chat without a supported chat-member read grant                   | Send fails closed                                         |

Per-user sharing is more secure since only chat participants can access the file. OpenClaw requires a successful member lookup for group chats; timeouts, transport failures, empty results, and Graph API denials fail the send instead of widening access to the organization.

### Fallback behavior

| Scenario                                                         | Result                                           |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| Group chat + file + SharePoint and member permissions configured | Upload to SharePoint, send a native file card    |
| Group chat + file + missing SharePoint or member permissions     | Fail with an actionable configuration error      |
| Channel + file + `sharePointSiteId` configured                   | Upload to SharePoint, send a native file card    |
| Personal chat + file                                             | FileConsentCard flow (works without SharePoint)  |
| Any context + image                                              | Base64-encoded inline (works without SharePoint) |

### Files stored location

Uploaded files are stored in a `/OpenClawShared/` folder in the configured SharePoint site's default document library.

## Polls (Adaptive Cards)

OpenClaw sends Teams polls as Adaptive Cards (there is no native Teams poll API).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> --poll-question "..." --poll-option "..." --poll-option "..."`.
- Votes are recorded by the gateway in OpenClaw plugin-state SQLite under `state/openclaw.sqlite`.
- Existing `msteams-polls.json` files are imported by `openclaw doctor --fix`, not by the running plugin.
- The gateway must stay online to record votes.
- Polls do not auto-post result summaries, and there is no poll-results CLI yet.

## Presentation cards

Send semantic presentation payloads to Teams users or conversations using the `message` tool, CLI, or normal reply delivery. OpenClaw renders them as Teams Adaptive Cards from the generic presentation contract.

The `presentation` parameter accepts semantic blocks. When `presentation` is provided, the message text is optional. Buttons render as Adaptive Card submit or URL actions. Select menus are not native in the Teams renderer, so OpenClaw downgrades them to readable text before delivery.

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

| Target type         | Format                           | Example                                                                                                |
| ------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| User (by ID)        | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                                                            |
| User (by name)      | `user:<display-name>`            | `user:John Smith` (requires Graph API)                                                                 |
| Group/channel       | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                                                               |
| Group/channel (raw) | `<conversation-id>`              | `19:abc123...@thread.tacv2`, `19:...@unq.gbl.spaces`, or a bare `a:`/`8:orgid:`/`29:` Bot Framework id |

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

- Proactive messages are only possible **after** a user has interacted, because OpenClaw stores conversation references at that point.
- See [/gateway/configuration](/gateway/configuration) for `dmPolicy` and allowlist gating.

## Team and Channel IDs (Common Gotcha)

The `groupId` query parameter in Teams URLs is **NOT** the team ID used for configuration. Extract IDs from the URL path instead:

**Team URL:**

```text
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team conversation ID (URL-decode this)
```

**Channel URL:**

```text
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**For config:**

- Team key = path segment after `/team/` (URL-decoded, e.g., `19:Bk4j...@thread.tacv2`; older tenants may show `@thread.skype`, which is also valid).
- Channel key = path segment after `/channel/` (URL-decoded).
- **Ignore** the `groupId` query parameter for OpenClaw routing. It is the Microsoft Entra group ID, not the Bot Framework conversation ID used in incoming Teams activities.

## Private channels

Bots have limited support in private channels:

| Feature                      | Standard channels | Private channels       |
| ---------------------------- | ----------------- | ---------------------- |
| Bot installation             | Yes               | Limited                |
| Real-time messages (webhook) | Yes               | May not work           |
| RSC permissions              | Yes               | May behave differently |
| @mentions                    | Yes               | If bot is accessible   |
| Graph API history            | Yes               | Yes (with permissions) |

**Workarounds if private channels do not work:**

1. Use standard channels for bot interactions.
2. Use DMs; users can always message the bot directly.
3. Use Graph API for historical access (requires `ChannelMessage.Read.All`).

## Troubleshooting

### Common issues

- **Images not showing in channels:** Graph permissions or admin consent missing. Reinstall the Teams app and fully quit/reopen Teams.
- **No responses in channel:** mentions are required by default; set `channels.msteams.requireMention=false` or configure per team/channel.
- **Version mismatch (Teams still shows old manifest):** remove + re-add the app and fully quit Teams to refresh.
- **401 Unauthorized from webhook:** expected when testing manually without an Azure JWT; means the endpoint is reachable but auth failed. Use Azure Web Chat to test properly.

### Manifest upload errors

- **"Icon file cannot be empty":** the manifest references icon files that are 0 bytes. Create valid PNG icons (32x32 for `outline.png`, 192x192 for `color.png`).
- **"webApplicationInfo.Id already in use":** the app is still installed in another team/chat. Find and uninstall it first, or wait 5-10 minutes for propagation.
- **"Something went wrong" on upload:** upload via [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) instead, open browser DevTools (F12) → Network tab, and check the response body for the actual error.
- **Sideload failing:** try "Upload an app to your org's app catalog" instead of "Upload a custom app"; this often bypasses sideload restrictions.

### RSC permissions not working

1. Verify `webApplicationInfo.id` matches your bot's App ID exactly.
2. Re-upload the app and reinstall in the team/chat.
3. Check if your org admin has blocked RSC permissions.
4. Confirm you are using the right scope: `ChannelMessage.Read.Group` for teams, `ChatMessage.Read.Chat` for group chats.

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

- [Channels Overview](/channels) - all supported channels
- [Pairing](/channels/pairing) - DM authentication and pairing flow
- [Groups](/channels/groups) - group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) - session routing for messages
- [Security](/gateway/security) - access model and hardening
