// Covers dangerous config flag detection and reporting.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { collectEnabledInsecureOrDangerousFlagsFromContracts } from "./dangerous-config-flags-core.js";
import { collectEnabledInsecureOrDangerousFlags } from "./dangerous-config-flags.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("collectEnabledInsecureOrDangerousFlags", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("keeps plugin contract checks enabled for a malformed roster", () => {
    const workspaceDir = tempDirs.make("openclaw-dangerous-workspace-");
    const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "workspace-danger");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      "export default { id: 'workspace-danger' };\n",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "workspace-danger",
        configSchema: { type: "object", additionalProperties: true },
        configContracts: { dangerousFlags: [{ path: "mode", equals: "danger" }] },
      }),
    );
    const flags = collectEnabledInsecureOrDangerousFlags(
      asConfig({
        agents: { entries: { alpha: { workspace: workspaceDir }, beta: {} } },
        plugins: {
          entries: {
            acpx: { config: { permissionMode: "approve-all" } },
            "workspace-danger": { config: { mode: "danger" } },
          },
        },
      }),
    );

    expect(flags).toContain("plugins.entries.acpx.config.permissionMode=approve-all");
    expect(flags).toContain("plugins.entries.workspace-danger.config.mode=danger");
  });

  it("uses the implicit main workspace for a rosterless compatibility config", () => {
    const workspaceDir = tempDirs.make("openclaw-dangerous-rosterless-");
    const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "workspace-danger");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      "export default { id: 'workspace-danger' };\n",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "workspace-danger",
        configSchema: { type: "object", additionalProperties: true },
        configContracts: { dangerousFlags: [{ path: "mode", equals: "danger" }] },
      }),
    );

    const flags = collectEnabledInsecureOrDangerousFlags(
      asConfig({
        agents: { defaults: { workspace: workspaceDir } },
        plugins: {
          entries: { "workspace-danger": { config: { mode: "danger" } } },
        },
      }),
    );

    expect(flags).toContain("plugins.entries.workspace-danger.config.mode=danger");
  });

  it("collects manifest-declared dangerous plugin config values", () => {
    expect(
      collectEnabledInsecureOrDangerousFlagsFromContracts(
        asConfig({
          plugins: {
            entries: {
              acpx: {
                config: {
                  permissionMode: "approve-all",
                },
              },
            },
          },
        }),
        {
          configContractsById: new Map([
            [
              "acpx",
              {
                configContracts: {
                  dangerousFlags: [{ path: "permissionMode", equals: "approve-all" }],
                },
              },
            ],
          ]),
        },
      ),
    ).toContain("plugins.entries.acpx.config.permissionMode=approve-all");
  });

  it("ignores plugin config values that are not declared as dangerous", () => {
    expect(
      collectEnabledInsecureOrDangerousFlagsFromContracts(
        asConfig({
          plugins: {
            entries: {
              other: {
                config: {
                  mode: "safe",
                },
              },
            },
          },
        }),
        {
          configContractsById: new Map([
            [
              "other",
              {
                configContracts: {
                  dangerousFlags: [{ path: "mode", equals: "danger" }],
                },
              },
            ],
          ]),
        },
      ),
    ).toStrictEqual([]);
  });

  it("collects dangerous sandbox, hook, browser, and fs flags", () => {
    const flags = collectEnabledInsecureOrDangerousFlagsFromContracts(
      asConfig({
        agents: {
          defaults: {
            sandbox: {
              docker: {
                dangerouslyAllowReservedContainerTargets: true,
                dangerouslyAllowContainerNamespaceJoin: true,
              },
            },
          },
          list: [
            {
              id: "worker",
              sandbox: {
                docker: {
                  dangerouslyAllowExternalBindSources: true,
                },
              },
            },
          ],
        },
        hooks: {
          allowRequestSessionKey: true,
        },
        browser: {
          ssrfPolicy: {
            dangerouslyAllowPrivateNetwork: true,
          },
        },
        tools: {
          fs: {
            workspaceOnly: false,
          },
        },
      }),
    );

    expect(flags).toStrictEqual([
      "hooks.allowRequestSessionKey=true",
      "browser.ssrfPolicy.dangerouslyAllowPrivateNetwork=true",
      "tools.fs.workspaceOnly=false",
      "agents.defaults.sandbox.docker.dangerouslyAllowReservedContainerTargets=true",
      "agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true",
      "agents.list.0.sandbox.docker.dangerouslyAllowExternalBindSources=true",
    ]);
  });

  it("collects configured security audit suppressions as a dangerous flag", () => {
    expect(
      collectEnabledInsecureOrDangerousFlagsFromContracts(
        asConfig({
          security: {
            audit: {
              suppressions: [{ checkId: "plugins.code_safety" }],
            },
          },
        }),
      ),
    ).toContain("security.audit.suppressions configured (1)");
  });

  it("uses legacy list indices for list-shaped dangerous sandbox flags", () => {
    expect(
      collectEnabledInsecureOrDangerousFlagsFromContracts(
        asConfig({
          agents: {
            list: [
              {
                id: "worker",
                sandbox: {
                  docker: {
                    dangerouslyAllowContainerNamespaceJoin: true,
                  },
                },
              },
              {
                id: "helper",
              },
            ],
          },
        }),
      ),
    ).toContain("agents.list.0.sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true");

    expect(
      collectEnabledInsecureOrDangerousFlagsFromContracts(
        asConfig({
          agents: {
            list: [
              {
                id: "helper",
              },
              {
                id: "worker",
                sandbox: {
                  docker: {
                    dangerouslyAllowContainerNamespaceJoin: true,
                  },
                },
              },
            ],
          },
        }),
      ),
    ).toContain("agents.list.1.sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true");
  });

  it("uses keyed roster paths for entries-shaped dangerous sandbox flags", () => {
    expect(
      collectEnabledInsecureOrDangerousFlagsFromContracts(
        asConfig({
          agents: {
            entries: {
              worker: {
                sandbox: {
                  docker: {
                    dangerouslyAllowContainerNamespaceJoin: true,
                  },
                },
              },
            },
          },
        }),
      ),
    ).toContain("agents.entries.worker.sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true");
  });
});
