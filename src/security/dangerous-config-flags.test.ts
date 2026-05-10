import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectEnabledInsecureOrDangerousFlagsFromContracts } from "./dangerous-config-flags-core.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("collectEnabledInsecureOrDangerousFlags", () => {
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
      'agents.list[id="worker"].sandbox.docker.dangerouslyAllowExternalBindSources=true',
    ]);
  });

  it("uses stable agent ids for per-agent dangerous sandbox flags", () => {
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
    ).toContain(
      'agents.list[id="worker"].sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true',
    );

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
    ).toContain(
      'agents.list[id="worker"].sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true',
    );
  });
});
