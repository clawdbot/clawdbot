# Visitor Access

Visitor Access is an internal OpenClaw plugin for granting individual people
access to <https://team.openclaw.ai>. It manages one dedicated Cloudflare Access
allow policy containing email addresses. Grants expire after 14 days by default;
maintainers can refresh or revoke them with agent tools.

The existing GitHub organization policy remains unchanged. Access allow policies
combine with OR semantics, so adding a visitor does not change maintainer access.
This package is private, built from source for the team deployment, and excluded
from the OpenClaw npm release.

## Configure the plugin

Use a Cloudflare API token that can read and write Access policies in the target
account. Enable the plugin in the source-built Gateway configuration:

```json5
{
  plugins: {
    entries: {
      "visitor-access": {
        enabled: true,
        config: {
          accountId: "<CLOUDFLARE_ACCOUNT_ID>",
          appId: "<ACCESS_APPLICATION_ID>",
          apiToken: "<RESOLVED_CLOUDFLARE_API_TOKEN>",
          policyName: "Visitors (openclaw-managed)",
          defaultTtlDays: 14,
          maxVisitors: 50,
        },
      },
    },
  },
}
```

Restart the Gateway after enabling the plugin or changing its configuration.
Do not retarget `accountId`, `appId`, or `policyName` while grants exist: the
durable records belong to that policy, and changing targets could leave the old
policy granting access without expiry sweeps. Revoke grants before retargeting.
Call `visitor_list` from a trusted, unsandboxed session to check policy access.
The first invite creates the named policy if it does not exist.
Tools require the running Gateway service; discovery alone never opens a separate
grant manager. Tool calls and expiry sweeps share that service's mutation queue.

| Field            | Required | Default                       | Constraints                             |
| ---------------- | -------- | ----------------------------- | --------------------------------------- |
| `accountId`      | Yes      | —                             | 1–128 letters, digits, `_`, or `-`.     |
| `appId`          | Yes      | —                             | 1–128 letters, digits, `_`, or `-`.     |
| `apiToken`       | Yes      | —                             | Nonempty resolved token string.         |
| `policyName`     | No       | `Visitors (openclaw-managed)` | 1–200 characters; exact policy name.    |
| `defaultTtlDays` | No       | `14`                          | Integer from 0 through 3650, or `null`. |
| `maxVisitors`    | No       | `50`                          | Integer from 1 through 500.             |

Use a secret reference value through your host or deployment's supported secret
resolution path, then pass the resolved string as `apiToken`. This plugin does
not resolve SecretRef objects itself. Do not paste a real token into chat or
commit it to source control. See [Secrets](https://docs.openclaw.ai/gateway/secrets)
for the host's supported credential surfaces.

Setting `defaultTtlDays` to `0` or `null` does not silently create permanent
grants: each invite must then supply positive `days` or explicitly set
`forever: true`.

## Invite, inspect, and revoke visitors

| Tool             | Input                                                 | Result                                                                                  |
| ---------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `visitor_invite` | `github` and/or `email`; optional `days` or `forever` | Adds a grant or refreshes an existing email's expiry.                                   |
| `visitor_list`   | `{}`                                                  | Shows grant emails, GitHub logins, invite dates, expiry dates, and policy/record drift. |
| `visitor_revoke` | `github` and/or `email`                               | Removes the matching visitor; an unknown email is a clean no-op.                        |

For example, invite a visitor for seven days:

```json
{ "github": "octocat", "email": "visitor@example.com", "days": 7 }
```

Invite results identify the visitor, email, expiry, and login URL. A repeat invite
for the same email refreshes its expiry rather than creating a second grant.
Permanent access requires `forever: true`. Invites beyond `maxVisitors` are
refused; revoke an existing visitor or deliberately raise the configured cap.

Visitors log in at <https://team.openclaw.ai> with their own GitHub account. The
GitHub identity provider authenticates accounts; the organization restriction
lives in the maintainer Access policy. The visitor policy matches the verified
email supplied by GitHub, so the invited email must belong to that account.

When only `github` is supplied, the plugin looks up that account's public GitHub
email. Many accounts have no public email. In that case, ask the visitor for the
email on their GitHub account and pass it explicitly; the plugin cannot discover
private account emails.

## Expiry and drift

Grants are recorded by lowercased email in the Gateway's durable keyed store.
Cloudflare Access is the enforcement surface; the store records who was invited
and when the grant expires. The store has a fixed cap of 500 records and does not
automatically expire them: a record must remain until policy cleanup succeeds.

An invite records the grant before calling Cloudflare. If that call fails, the
record remains so a later list can expose the drift and a sweep can clean up any
expired grant. Revoke removes policy access before deleting the record. Re-invite
to retry an unsuccessful invite, or revoke to clean up its record.

The plugin sweeps expired grants on Gateway startup and hourly while the Gateway
runs. It removes each expired email from the named Access policy and the local
record, then logs the removal. Expiry is best effort: the Gateway and Cloudflare
API must be available, and a grant can remain allowed until a successful sweep.
Use an explicit revoke to remove the email from the allow policy without waiting
for the hourly sweep. This plugin does not separately revoke Access sessions.

Both list and sweep compare policy emails with recorded grants. Emails added
manually in the Cloudflare dashboard are reported as **unmanaged** and are never
automatically deleted. Remove them with an explicit `visitor_revoke`. Recorded
grants missing from the policy are reported as drift; invite again to restore
access or revoke to remove the stale record.

Each Cloudflare mutation reads the policy again before writing its full email
include list. No include list is cached across calls. Keep one Gateway responsible
for this policy and avoid concurrent dashboard edits: a full-list update cannot
merge an external edit made between that read and write.

## Trust model and boundaries

**Anyone who can drive an unsandboxed session can manage visitors.** Tool
availability relies on sandbox tool policy: these plugin tools are not in the
sandbox's default allowlist, so guest sessions using that policy cannot call
them. Custom overrides, including an empty `tools.sandbox.tools.allow` list or
`alsoAllow` entries for these tools or `group:plugins`, can change this boundary.
Do not allow these tools in guest or sandbox policies. The team's existing
default `guest` role forces sandboxing for unknown authenticated users; this
plugin does not change Gateway roles or authorization.

The plugin only manages the policy whose name exactly matches `policyName`. It
does not modify or reorder any other policy, including the maintainer organization
policy. A matching policy whose decision is not `allow` causes a clear refusal.
Cloudflare requests use app-scoped policy endpoints only: no identity-provider
calls and no application mutations. Tokens are never logged or echoed, and fetch
failures use generic diagnostics.
Non-email include rules, nonempty require/exclude rules, or duplicate matching
policy names also require operator inspection before the plugin will write.

Identity-provider management, self-service signup queues, invitation email
delivery, and deep SecretRef support are deliberately outside this plugin's
scope. A maintainer approves each invitation through a trusted session.
