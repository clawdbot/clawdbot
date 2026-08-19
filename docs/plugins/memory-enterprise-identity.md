---
summary: "Link verified Entra ID, Google Workspace, or Okta identities to scoped memory access"
read_when:
  - You want enterprise group membership to govern access to scoped memory
  - You are configuring Microsoft Entra ID, Google Workspace, or Okta for memory identity
title: "Enterprise Memory Identity"
sidebarTitle: "Enterprise Memory Identity"
---

Enterprise memory identity is an optional set of plugins that links a signed
enterprise identity to the currently authenticated Gateway user. It is off by
default. It never derives memory identity from a channel sender id, tool
arguments, or session membership.

The Gateway starts a user-bound confidential OIDC authorization-code flow with
PKCE, state, nonce, and `max_age`. Its HTTPS callback requires a client secret
kept as a SecretRef; the Gateway sends that secret only to the configured token
endpoint. On return it validates the ID token and creates a
revisioned, redacted enterprise membership snapshot. A link can only affect the
Gateway user who started that exact flow.

## Enable one provider

Install the provider plugin, configure it, place its prefix in the operator
allowlist, then restart the Gateway. A configured plugin alone is not enough:
both `enabled` and the provider allowlist are required.

```bash
openclaw plugins install @openclaw/memory-identity-entra
openclaw plugins install @openclaw/memory-identity-google-workspace
openclaw plugins install @openclaw/memory-identity-okta
```

Install only the provider you intend to configure. If your deployment sets
`plugins.allow`, add that provider's plugin ID too, such as
`memory-identity-entra`. `plugins.allow` controls which plugins may load;
`plugins.enterpriseIdentityProviders.allow` separately controls which identity
authorities may contribute verified evidence.

### Microsoft Entra ID

Configure a confidential web app registration for the exact tenant and callback
URL. Store its client secret as a SecretRef. In **Token configuration**, add a
Groups claim to ID tokens and scope it to groups assigned to the application
where that is operationally suitable. Before enabling memory, complete one
sign-in and inspect the ID token: it must contain a complete
`groups` array of Entra object IDs. Tokens carrying `hasgroups` or
`_claim_names.groups` are overage/partial snapshots and are denied; OpenClaw
never calls Graph as a fallback. Assign only immutable Entra group object IDs to
memory roles.

```json5
{
  plugins: {
    enterpriseIdentityProviders: { allow: ["entra"] },
    entries: {
      "memory-identity-entra": {
        enabled: true,
        config: {
          tenantId: "00000000-0000-0000-0000-000000000000",
          clientId: "00000000-0000-0000-0000-000000000002",
          clientSecret: { source: "env", provider: "default", id: "ENTRA_MEMORY_CLIENT_SECRET" },
          redirectUri: "https://gateway.example/memory/oidc/callback",
          roleGroupIds: ["00000000-0000-0000-0000-000000000001"],
        },
      },
    },
  },
}
```

### Google Workspace

Google ID tokens identify a user but do not carry Workspace group membership.
Configure a confidential web OAuth client and store its client secret as a
SecretRef. Also configure a domain-wide-delegation service-account credential
as a SecretRef and a delegated admin in `hostedDomain`, with Cloud Identity
`groups.readonly` scope. The plugin obtains only a short-lived Cloud Identity access token; core
queries and validates transitive membership and retains only the configured
immutable `groups/<id>` role groups. Never use a group display name. Optionally
set the canonical Cloud Identity `customerId` (`C...`) to constrain the
directory query to one customer.

```json5
{
  plugins: {
    enterpriseIdentityProviders: { allow: ["google-workspace"] },
    entries: {
      "memory-identity-google-workspace": {
        enabled: true,
        config: {
          hostedDomain: "example.com",
          clientId: "oauth-client-id",
          clientSecret: {
            source: "env",
            provider: "default",
            id: "GOOGLE_WORKSPACE_CLIENT_SECRET",
          },
          redirectUri: "https://gateway.example/memory/oidc/callback",
          delegatedAdminEmail: "workspace-admin@example.com",
          directoryServiceAccount: { source: "env", provider: "default", id: "GOOGLE_DWD_JSON" },
          roleGroupResourceNames: ["groups/0123456789"],
        },
      },
    },
  },
}
```

### Okta

Use a custom authorization server, not the org authorization server. Its issuer
must have the form `https://{yourOktaDomain}/oauth2/{authorizationServerId}`;
`default` is valid. Configure an ID-token custom claim such as
`openclaw_group_ids` that emits immutable Okta group IDs (`00g...`), not group
names, and make it always include the configured role groups. The verified
issuer itself is the Okta tenant boundary. Register the integration as a
confidential web application and store its client secret as a SecretRef.

```json5
{
  plugins: {
    enterpriseIdentityProviders: { allow: ["okta"] },
    entries: {
      "memory-identity-okta": {
        enabled: true,
        config: {
          issuer: "https://example.okta.com/oauth2/memory",
          clientId: "oauth-client-id",
          clientSecret: { source: "env", provider: "default", id: "OKTA_MEMORY_CLIENT_SECRET" },
          redirectUri: "https://gateway.example/memory/oidc/callback",
          groupIdsClaim: "openclaw_group_ids",
          roleGroupIds: ["00g00000000000000001"],
        },
      },
    },
  },
}
```

## Operational behavior

- Restart the Gateway after changing any provider, allowlist, group mapping, or
  callback URL. Provider authority policy is sealed at startup.
- An issuer, audience, signature, nonce, tenant, assurance, group-snapshot,
  freshness, or directory failure denies private-memory access.
- Membership evidence stores reduced stable references and revisions, not raw
  JWTs, access tokens, email addresses, or unconfigured groups.
- Gateway collaboration membership and enterprise membership are separate.
  `session_members` never grants enterprise identity access.

## Review redacted decisions

Gateway operators can start and complete an identity link only for their own
authenticated profile with `memory.enterpriseIdentity.authorization.start` and
`memory.enterpriseIdentity.authorization.complete` (`operator.write`).

`memory.enterpriseIdentity.accessAudit.list` and
`memory.enterpriseIdentity.policyDriftAlerts.list` require `operator.read` and
take a `userProfileId`. `memory.enterpriseIdentity.evidenceTransitions.list`
uses the same owner-or-`operator.admin` object boundary to show a bounded
refresh or revocation history. A read-scoped caller cannot select another
profile. Lifecycle history stays with the profile linked when each event
occurred; relinking an enterprise identity never transfers historical entries
to the new profile. These operations return redacted decision evidence, an
allow/deny flip from the selected memory plugin, or a provider lifecycle count.
Results identify provider, opaque tenant and rule references, policy/evidence
revisions, role-store scope, lifecycle timestamps, and only the number of
superseded snapshots. They never return group names, snapshot or transition
IDs, resource titles, memory content, raw claims, tokens, or a Gateway
collaboration session.

`memory.enterpriseIdentity.accessAudit.export` requires `operator.write` and
returns one bounded redacted snapshot of that same profile's decisions, policy
drift alerts, and lifecycle-impact counts. The profile owner can export its
own record; an attributed `operator.admin` can export any profile's record.
It is a structured response, not a file download, and each collection is
capped at 100 entries.

The two write controls also use the owner-or-attributed-`operator.admin`
boundary and accept only a Gateway `userProfileId` plus configured provider:

- `memory.enterpriseIdentity.unlink` removes the current profile association
  and immediately denies future enterprise-memory access. It preserves
  verifier evidence, lifecycle history, access audit, and prior exposure.
- `memory.enterpriseIdentity.evidence.revoke` additionally revokes the
  current verified evidence and membership snapshots. A fresh verified OIDC
  flow is required before that identity can be linked again.

Both controls return provider and count-only results, persist a redacted actor
and target action record, and never accept or return an enterprise principal,
link, snapshot, store, resource, session, run, or exposure identifier. They
do not delete private-memory content; content deletion remains an authorized
operation of the selected memory backend.

Each evidence-transition result also reports a count-only revocation impact:
the number of prior content exposures associated with the superseded snapshots.
`complete: false` means at least one registered agent database could not be
read or lacks the required ledger, so the count must not be interpreted as a
final zero. The response never identifies an affected store, resource, agent,
session, run, snapshot, or exposure.
