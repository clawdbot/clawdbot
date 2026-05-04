# Microsoft Teams Downstream Profile Example

This is a minimal OpenClaw plugin for the production-shaped Teams delegated auth
flow:

Teams user -> OpenClaw tool -> downstream API token -> downstream API -> Graph OBO

It registers one optional tool:

- `msteams_whoami` - asks the Teams channel runtime for a delegated token whose
  audience is your downstream API, calls `GET <downstreamBaseUrl>/api/me`, and
  returns the user's display name and email/UPN from that downstream response.

The plugin does not call Microsoft Graph directly. The downstream API must
validate the inbound JWT, require the expected delegated scope, and perform the
Microsoft Entra on-behalf-of exchange to Graph server-side.

## Current PoC Shape

Use separate app registrations:

- `BOT_APP_ID` - Azure Bot Microsoft App ID. This is
  `channels.msteams.appId` and `bots[].botId`.
- `DOWNSTREAM_APP_ID` - Entra app registration for your API. This is the Teams
  SSO `webApplicationInfo.id`, the OAuth connection client ID, and the token
  audience client ID. The Application ID URI remains
  `api://<DOWNSTREAM_APP_ID>`.

Use these placeholder values while following the steps:

```bash
BOT_APP_ID="<azure-bot-microsoft-app-id>"
BOT_SECRET="<azure-bot-client-secret>"
TENANT_ID="<tenant-id>"
DOWNSTREAM_APP_ID="<downstream-api-app-id>"
DOWNSTREAM_SECRET="<downstream-api-client-secret>"
DOWNSTREAM_RESOURCE="api://$DOWNSTREAM_APP_ID"
DOWNSTREAM_SCOPE_NAME="downstream.access"
DOWNSTREAM_SCOPE="$DOWNSTREAM_RESOURCE/$DOWNSTREAM_SCOPE_NAME"
DOWNSTREAM_API_URL="http://127.0.0.1:4010"
OAUTH_CONNECTION="DownstreamApiConnection"
```

## Microsoft Setup

1. Azure Bot:
   - Create a single-tenant Azure Bot.
   - Enable the Microsoft Teams channel.
   - Set the messaging endpoint to `https://<tunnel-host>/api/messages`.
   - Keep the Microsoft App ID and client secret as `BOT_APP_ID` and
     `BOT_SECRET`.

2. Downstream Entra app registration:
   - Create a single-tenant app registration for the downstream API.
   - Set `requestedAccessTokenVersion` to `2` in the app manifest.
   - Add the redirect URI
     `https://token.botframework.com/.auth/web/redirect`.
   - Expose an API with Application ID URI `api://<DOWNSTREAM_APP_ID>`.
   - Add delegated scope `downstream.access`.
   - Pre-authorize Teams clients for that scope:
     - Teams desktop/mobile: `1fec8e78-bce4-4aaf-ab1b-5451cc387264`
     - Teams web: `5e3ce6c0-2b1f-4285-8d4b-75ee78787346`
   - Add Microsoft Graph delegated permission `User.Read`.
   - Grant admin consent for the downstream API app. Without this, the local API
     receives `AADSTS65001` when it tries to exchange the Teams token to Graph,
     because the OBO exchange cannot show an interactive Graph consent prompt.
   - Create a client secret and keep it as `DOWNSTREAM_SECRET`.

3. Azure Bot OAuth connection:
   - Open Azure Bot -> Configuration -> Add OAuth Connection Settings.
   - Name: `DownstreamApiConnection`.
   - Service Provider: `Azure Active Directory v2`.
   - Client ID: `DOWNSTREAM_APP_ID`.
   - Client secret: `DOWNSTREAM_SECRET`.
   - Tenant ID: `TENANT_ID`.
   - Token Exchange URL: `api://<DOWNSTREAM_APP_ID>`.
   - Scopes: `api://<DOWNSTREAM_APP_ID>/downstream.access`.

4. Teams app manifest:

   ```json5
   {
     bots: [
       {
         botId: "<BOT_APP_ID>",
         scopes: ["personal", "team", "groupChat"],
         supportsFiles: true,
       },
     ],
     validDomains: ["token.botframework.com", "<your-tunnel-host-or-domain>"],
     webApplicationInfo: {
       id: "<DOWNSTREAM_APP_ID>",
       resource: "api://<DOWNSTREAM_APP_ID>",
     },
   }
   ```

## OpenClaw Setup

Install or load this local plugin:

```bash
openclaw plugins install ./examples/plugins/msteams-graph-profile
```

Use the same OpenClaw profile for install and runtime. For the dev profile, run:

```bash
pnpm openclaw --dev plugins install ./examples/plugins/msteams-graph-profile
```

Local plugin installs use the runnable files from the package. If you edit this
example after installing it, run the install command again and restart the
Gateway.

## Run The Local Downstream API

This example includes the downstream service in its nested `downstream`
package. It is intentionally local-only by default and listens on
`127.0.0.1:4010`, because only the OpenClaw plugin calls it. Teams does not need
to reach this API directly.

Install the downstream package independently so it does not join or modify the
OpenClaw workspace dependency graph, then run it from the repository root:

```bash
pnpm --dir examples/plugins/msteams-graph-profile/downstream \
  install --ignore-workspace --no-lockfile

MSTEAMS_OBO_TENANT_ID="<TENANT_ID>" \
MSTEAMS_OBO_DOWNSTREAM_CLIENT_ID="<DOWNSTREAM_APP_ID>" \
MSTEAMS_OBO_DOWNSTREAM_CLIENT_SECRET="<DOWNSTREAM_SECRET>" \
MSTEAMS_OBO_SCOPE="downstream.access" \
pnpm --dir examples/plugins/msteams-graph-profile/downstream \
  --ignore-workspace start
```

Optional environment variables:

- `MSTEAMS_OBO_AUDIENCE` - accepted JWT audience, defaults to
  `<DOWNSTREAM_APP_ID>`. If set to `api://<DOWNSTREAM_APP_ID>`, the example
  also accepts the bare client-id audience that Microsoft Entra emits for this
  Teams SSO token.
- `MSTEAMS_OBO_HOST` - bind address, defaults to `127.0.0.1`.
- `MSTEAMS_OBO_PORT` - bind port, defaults to `4010`.
- `MSTEAMS_OBO_GRAPH_SCOPES` - comma or space separated Graph scopes, defaults
  to `https://graph.microsoft.com/User.Read`.

Check that it is listening:

```bash
curl http://127.0.0.1:4010/health
```

Configure OpenClaw:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<BOT_APP_ID>",
      appPassword: "<BOT_SECRET>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
      sso: {
        enabled: true,
        connectionName: "DownstreamApiConnection",
      },
    },
  },
  plugins: {
    entries: {
      "msteams-graph-profile": {
        enabled: true,
        config: {
          downstreamBaseUrl: "http://127.0.0.1:4010",
          audience: "api://<DOWNSTREAM_APP_ID>",
          scope: "downstream.access",
          profilePath: "/api/me",
        },
        auth: {
          delegatedAccess: {
            enabled: true,
            providers: ["msteams"],
            audiences: ["api://<DOWNSTREAM_APP_ID>"],
            scopes: ["downstream.access"],
            chatTypes: ["direct"],
          },
        },
      },
    },
  },
  tools: {
    allow: ["msteams_whoami"],
  },
}
```

Keep the downstream API running, restart the Gateway, then ask from a Teams DM:

```text
Use msteams_whoami to tell me my email.
```

If Bot Framework has no stored token for your user, OpenClaw sends a Teams
sign-in card through the Teams SDK. Complete it once, wait for the Gateway log
entry that says the SSO token was exchanged or verified, then send the prompt
again.

## Downstream API Contract

The plugin calls:

```http
GET /api/me
Authorization: Bearer <delegated token for DOWNSTREAM_APP_ID>
Accept: application/json
```

The downstream API should:

1. Validate the JWT signature using Microsoft Entra metadata for `TENANT_ID`.
2. Require `aud` to equal `<DOWNSTREAM_APP_ID>`. OpenClaw plugin policy may use
   `api://<DOWNSTREAM_APP_ID>`; for this Entra app-id URI shape OpenClaw treats
   it as equivalent to the bare client-id `aud` claim.
3. Require `scp` to include `downstream.access`.
4. Use the inbound bearer token as the OBO assertion.
5. Request a Graph token for `https://graph.microsoft.com/User.Read`.
6. Call `GET https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName`.
7. Return:

   ```json
   {
     "displayName": "Ada Lovelace",
     "email": "ada@example.com",
     "userPrincipalName": "ada@example.com"
   }
   ```

In Node, the OBO call is the `@azure/msal-node` confidential-client flow:

```typescript
const result = await confidentialClient.acquireTokenOnBehalfOf({
  oboAssertion: inboundBearerToken,
  scopes: ["https://graph.microsoft.com/User.Read"],
});
```

Keep token validation and OBO in the downstream API. Do not forward a Graph token
from OpenClaw to your service.

The nested
`examples/plugins/msteams-graph-profile/downstream/server.ts` implements that
contract:

- Validates the inbound token with Microsoft Entra JWKS for `TENANT_ID`.
- Requires `aud` to match `MSTEAMS_OBO_AUDIENCE`, accepting
  `api://<DOWNSTREAM_APP_ID>` as equivalent to `<DOWNSTREAM_APP_ID>`.
- Requires `scp` to include `MSTEAMS_OBO_SCOPE`.
- Uses `@azure/msal-node` `acquireTokenOnBehalfOf` to request Graph
  `User.Read`.
- Calls Graph `/me` and returns the profile shape consumed by `msteams_whoami`.

Do not log the inbound bearer token or Graph token while debugging. The example
server logs only tenant/user identifiers after a successful profile lookup.

## Troubleshooting

- `auth_context_missing`: the tool is visible, but the active tool execution did
  not receive delegated auth context. Reinstall the local plugin if you changed
  it, restart the Gateway, and confirm the config key is
  `plugins.entries.msteams-graph-profile`.
- `not_configured`: OpenClaw rejected the delegated-auth request before asking
  Teams for a token. Check `channels.msteams.sso.connectionName`, the plugin
  `auth.delegatedAccess.providers`, `audiences`, and `scopes`, and make sure the
  tool request uses `provider: "msteams"`.
- `missing_consent`: Bot Framework has no stored user token for the OAuth
  connection. Complete the OAuth card or sign-in link, then retry
  `msteams_whoami`. Plain-message magic-code handling is not part of this
  integration.
- `unavailable`: Teams delegated auth was configured, but token resolution or
  claim validation failed. Enable debug logging and check for
  `msteams delegated auth token rejected by requested claims` or
  `plugin delegated auth token rejected by plugin policy claims`; those usually
  mean the OAuth connection, plugin `audience`, or `scope` values do not match
  the returned JWT claims.
- `graph_consent_required` or `AADSTS65001` from the downstream API: the Teams
  delegated token reached the API, but the downstream Entra app still lacks
  consent for the configured Graph delegated permission. Open the downstream app
  registration, go to **API permissions**, add Microsoft Graph delegated
  `User.Read` if missing, then click **Grant admin consent** for the tenant.
- `invalid_token`: the token did not validate for this API. Check
  `MSTEAMS_OBO_TENANT_ID`, `MSTEAMS_OBO_DOWNSTREAM_CLIENT_ID`, and
  `MSTEAMS_OBO_AUDIENCE`.
- `missing_scope`: the Bot Framework OAuth connection is not issuing
  `downstream.access`. Check the OAuth connection scope
  `api://<DOWNSTREAM_APP_ID>/downstream.access`.
