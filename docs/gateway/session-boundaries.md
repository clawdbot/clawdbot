---
summary: "Session Steward boundary model for Gateway session keys, redaction, and diagnostics"
read_when:
  - Debugging session key agent mismatch errors
  - Reviewing Gateway session boundary behavior
  - Auditing redacted Session Steward diagnostics
title: "Session boundaries"
---

Session Steward protects session identity, ownership, delegation, approval,
redaction, and telemetry boundaries. It treats `sessionKey` values as
routing/context selectors, not as bearer credentials or per-user authorization
tokens.

The recommended operator model is still one trusted Gateway boundary per user,
team, or host. If you need real separation between mutually untrusted users,
run separate Gateways with separate credentials, and preferably separate OS
users or hosts. Session boundaries reduce accidental cross-agent routing and
unsafe diagnostic disclosure inside one Gateway; they do not turn one shared
Gateway into hostile multi-tenant isolation.

Related: [Security](/gateway/security), [Operator scopes](/gateway/operator-scopes),
[Tools invoke HTTP API](/gateway/tools-invoke-http-api), and
[OpenTelemetry](/gateway/opentelemetry). For credential resolution semantics,
see [Auth credential semantics](/auth-credential-semantics).

## Boundary kinds

Session Steward classifies session selectors before Gateway methods use them.
Boundary decisions expose only normalized ownership and redacted session facts.

| Session selector shape | Boundary kind | Behavior                                                                                                                                   |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent:<agentId>:...`  | `agent`       | Scoped to the normalized owner agent. Decisions report `agent:<agentId>:REDACTED`.                                                         |
| `global`               | `global`      | Gateway-global context. Allowed with an explicit `agentId` when the method supports it.                                                    |
| non-agent legacy keys  | `unscoped`    | Legacy or channel-specific selector with no agent owner encoded in the key. Existing store-owner resolution still applies where supported. |
| missing or blank key   | `unknown`     | No trusted owner can be inferred. Methods either resolve a default context or reject according to their existing contract.                 |
| malformed agent key    | `malformed`   | Invalid `agent:*` selector. Gateway methods that enforce Session Steward boundaries reject it as `INVALID_REQUEST`.                        |

## Agent relation decisions

For `agent:<agentId>:...` selectors, Session Steward compares the owner agent in
the selector with the requested agent, when a requested agent is present.

| Relation      | Meaning                                                          | Gateway result                                                      |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `same_agent`  | The session owner and requested agent match after normalization. | The request proceeds.                                               |
| `cross_agent` | The session owner and requested agent differ.                    | Enforced Gateway surfaces reject the request as `INVALID_REQUEST`.  |
| `unbound`     | No comparable owner or requested agent exists.                   | The method follows its normal defaulting or legacy resolution path. |

This means a request that combines a session owned by one agent with a different
explicit `agentId` fails before the handler mutates state or invokes a tool.
The error details include redacted boundary facts, not the raw selector.

## Gateway surfaces currently enforced

Session Steward enforcement currently covers these Gateway surfaces:

- `tools.effective`
- `tools.invoke`
- `sessions.files.list`
- `sessions.files.get`
- `sessions.files.set`
- `sessions.files.reveal`
- `sessions.create`
- `sessions.abort`
- `sessions.usage`
- `sessions.reset`

Other session methods retain their existing routing checks and can be added to
this policy surface independently.

The policy is intentionally strict for malformed `agent:*` selectors and
cross-agent mismatches. It is intentionally compatible for `global` selectors
with explicit `agentId` and for supported legacy unscoped selectors.

## Redaction contract

Session Steward decisions and diagnostics must not include raw high-cardinality
or sensitive values. The allowed session fact is the normalized owner agent plus
a redacted affected-session value such as `agent:<agentId>:REDACTED`.

Never emit these raw values in Session Steward decisions, errors, logs,
diagnostic attributes, or metrics:

- session tails
- peer IDs
- thread IDs
- request bodies
- tokens
- cookies
- passwords
- API keys
- private keys
- credential material

This redaction contract is why Session Steward returns `UNKNOWN`, `UNSCOPED`,
`GLOBAL`, or `agent:<agentId>:REDACTED` instead of echoing caller-provided
session selectors.

## Diagnostics

Gateway Session Steward checks emit trusted diagnostic events with redacted
metadata only:

- `session_steward.boundary_decision`
- `session_steward.boundary_rejected`

Event attributes may include the Gateway surface, action, outcome, boundary
kind, agent relation, owner agent, requested agent, and redacted affected
session. They must not include the raw `sessionKey`, request body, peer IDs,
thread IDs, or credential-like values.

OpenTelemetry and Prometheus exporters apply their own low-cardinality and
redaction rules on top of these diagnostics. See
[OpenTelemetry privacy and content capture](/gateway/opentelemetry#privacy-and-content-capture)
and [Prometheus label policy](/gateway/prometheus#label-policy).

## Browser Steward compatibility

The combined Browser / Session / Credential Steward remains active for browser
runtime compatibility. Browser-side checks use exact owner classification and
the same `global`, unscoped, malformed, and redacted agent-boundary semantics as
the core policy. Credential-side checks classify credential-like request data,
block raw credential exposure from generic diagnostics, and keep Browser
Steward decisions and tracked metadata limited to redacted credential classes
and reason codes. A trusted operator approval may authorize the browser action,
but it does not authorize exposing the credential value in decisions,
diagnostics, or tracked metadata.

Credential Steward redaction policy does not resolve credentials, migrate auth
profiles, or change credential storage. It is a safety boundary that always
blocks reporting raw credential material; browser execution authorization is a
separate trusted approval decision.

The Browser-owned node delegation capability is an internal, in-process seam for
the bundled meeting integrations registered by Browser (`google-meet`,
`teams-meetings`, and `zoom-meetings`). It is not a general-purpose node
invocation API: Browser controls the consumer allowlist, injects the consumer
identity, requires the Browser Steward approval boundary, and revokes retained
handles when the Browser or consumer lifecycle changes. Meeting integrations
must use this capability instead of calling raw `browser.proxy` node commands.

## Troubleshooting

If a Gateway call returns `INVALID_REQUEST` with `session key agent does not
match agentId`, check the caller is not mixing an `agent:<agentId>:...` selector
owned by one agent with another explicit `agentId`.

If a Gateway call returns `INVALID_REQUEST` with `malformed session boundary`,
check that any agent-scoped selector has a non-empty owner segment and a
non-empty opaque tail. The valid shape is `agent:<agentId>:<session-scope>`;
the tail may itself contain additional colons. Empty owners and missing tails,
such as `agent::...` or `agent:<agentId>`, are malformed. A selector such as
`agent:<agentId>:` has an empty tail and is therefore malformed; a trailing colon
is accepted only after a non-empty scope, such as `agent:<agentId>:<scope>:`.

If diagnostics appear to contain raw session material, treat that as a redaction
bug. Capture the diagnostic event type and surface, but do not paste secrets,
session tails, peer IDs, thread IDs, cookies, tokens, passwords, API keys, or
private keys into an issue or support thread.
