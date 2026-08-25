---
summary: "Contract for OS packages and external supervisors that own OpenClaw updates and Gateway lifecycle"
read_when:
  - You package OpenClaw in an OS-native installer or application bundle
  - Another process manager owns Gateway updates and restarts
title: "External package ownership"
---

OS packages and application bundles can own the OpenClaw runtime without
letting the bundled CLI replace package-managed files or create a second host
service.

Launch every bundled OpenClaw process with:

```text
OPENCLAW_SUPERVISOR_MODE=external
OPENCLAW_NO_AUTO_UPDATE=1
```

These variables have separate responsibilities:

- `OPENCLAW_SUPERVISOR_MODE=external` declares that another process manager
  owns the Gateway lifecycle. Native service install, start, stop, and
  uninstall operations are refused. Manual self-update is also refused so the
  package manager can stop the Gateway, replace the runtime, and restart it as
  one operation.
- `OPENCLAW_NO_AUTO_UPDATE=1` disables automatic update checks, notices, and
  applies. It does not replace the external-supervisor lifecycle contract.

## Package responsibilities

The package owner must:

1. Run the Gateway in the foreground with `openclaw gateway run`.
2. Stop the running Gateway before replacing packaged runtime files.
3. Update the OpenClaw package and its Node.js runtime together.
4. Restart the Gateway only after the new runtime is fully installed.
5. Preserve the user's normal OpenClaw state unless the user explicitly
   requests removal.
6. Document whether the package replaces or coexists with another `openclaw`
   executable on the same host.

Do not invoke `openclaw gateway install` from a package-owned runtime. That
would create a second lifecycle owner outside the package manager.

## Update and rollback flow

Use this order for upgrades and rollbacks:

1. Block new launches.
2. Stop the package-owned Gateway.
3. Stage and verify the complete replacement runtime.
4. Atomically activate the replacement when the platform supports it.
5. Start `openclaw gateway run` with both ownership variables.
6. Verify the Gateway version and health.
7. Retain or remove the previous runtime according to the package rollback
   policy.

For shared-state compatibility checks across releases, follow the
[database preflight guidance](/reference/database-schemas).

## Related behavior

- [Gateway external supervisors](/cli/gateway#external-supervisors)
- [Update controls](/install/updating#update-campaigns)
- [Environment variables](/help/environment)

