# Gateway Runtime Completeness

Use this rubric when assigning category Completeness scores for the
`gateway-runtime` surface.

## Surface-Specific Scoring Questions

For each category, ask:

- Does the category cover the main happy path an operator or client needs?
- Are the major deployment modes present where they matter for this category:
  local, remote, node-mediated, supervised, or browser-facing?
- Are the main lifecycle stages present where relevant: setup, normal use,
  status/inspection, and recovery?
- Are important security or policy branches present where the category implies
  them?
- Are obvious operator-visible holes or "not yet supported" branches still
  missing?

## Surface-Specific Guidance

Variation from the default completeness process:

- Completeness includes operator and connected-client workflows, major deployment modes, and recovery paths, not just gateway protocol capability.
- Score the Gateway against the full operator and client journey, not just protocol primitives or one transport path.
- Local, remote, node-mediated, supervised, and browser-facing modes matter when the category implies them.
- Approval/policy variants and recovery or diagnostic paths count as completeness branches, not polish.

## Category Scope

- Approvals and Remote Execution: Exec approvals, Plugin approvals, Node exec approvals, Approved node execution, Approval mutation safety, Delivery fallback behavior
- HTTP APIs: OpenAI-compatible APIs, Tool invocation API, Admin API access, Hook ingress
- Hosted Web Surface: Control UI, WebChat hosting, Plugin web routes, Canvas and A2UI routes
- Gateway RPC APIs and Events: Health APIs, Identity and presence APIs, Model APIs, Usage and memory APIs, Session APIs, Chat APIs, Channel APIs, Web login and wake APIs, Config and secrets APIs, Update and setup APIs, Agent and artifact APIs, Task and automation APIs, Tool and skill APIs, Request and event envelopes, Idempotent side effects, Method discovery, Event discovery, Accepted-then-final results, Event ordering, State refresh after gaps
- Device Auth and Pairing: Shared-secret login, Trusted proxy auth, Private ingress mode, Device challenge signing, Device tokens, Setup-code bootstrap, Auth mismatch recovery, Device auth migration, Client pairing, Node pairing
- Network Access and Discovery: Loopback and LAN access, Tailnet access, SSH tunnels, Endpoint discovery, Saved endpoints, TLS pinning
- Nodes and Remote Capabilities: Node presence, Node capabilities, Node inventory, Node actions, Node events, Pending work delivery, Remote device capabilities, Remote host commands
- Health, Diagnostics, and Repair: Health snapshots, Channel readiness, Stability diagnostics, Payload diagnostics, Diagnostics exports, Doctor checks, Log tailing
- Protocol Compatibility: Published protocol schema, Runtime request validation, JSON Schema export, Swift client models, Version negotiation, Client transport defaults, Backward-compatible evolution
- Roles and Permissions: Role negotiation, Operator permissions, Approval-gated actions, Untrusted node declarations, Event scoping
- Gateway Lifecycle: Foreground startup, Service installation, Restart and stop, Service status, Bind and port settings, Config reload, Multi-gateway isolation
- Security Controls: Non-loopback auth, Trusted proxy exceptions, Gateway and node trust boundaries, Trusted CIDR auto-approval, Fail-closed protocol handling, Remote execution safeguards
- WebSocket Connection: WebSocket transport, Connect challenge, Connect request, Protocol version negotiation, hello-ok snapshot, Startup retry, Session limits, Plugin surface URLs
