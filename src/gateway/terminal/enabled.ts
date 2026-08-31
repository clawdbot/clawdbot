// Canonical read of `gateway.terminal.enabled`: the operator terminal is on by
// default and operators opt out with `enabled: false`. Deliberate maintainer
// decision: admin-scope operators already hold gateway control, so default-on
// trades that (documented) shell exposure for discoverability; sandboxed
// agents stay refused. Lives outside launch.ts so eagerly-loaded HTTP/CSP
// paths can import it without defeating the lazy import of the launch policy
// in server-runtime-state-prepare.ts.
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function isTerminalConfigEnabled(config: OpenClawConfig | undefined): boolean {
  return config?.gateway?.terminal?.enabled !== false;
}
