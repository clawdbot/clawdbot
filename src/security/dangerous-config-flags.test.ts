import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectEnabledInsecureOrDangerousFlags } from "./dangerous-config-flags.js";

const { resolvePluginConfigContractsByIdMock } = vi.hoisted(() => ({
  resolvePluginConfigContractsByIdMock: vi.fn(),
}));

vi.mock("../plugins/config-contracts.js", () => ({
  collectPluginConfigContractMatches: ({
    pathPattern,
    root,
  }: {
    pathPattern: string;
    root: Record<string, unknown>;
  }) => (Object.hasOwn(root, pathPattern) ? [{ path: pathPattern, value: root[pathPattern] }] : []),
  resolvePluginConfigContractsById: resolvePluginConfigContractsByIdMock,
}));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("collectEnabledInsecureOrDangerousFlags", () => {
  beforeEach(() => {
    resolvePluginConfigContractsByIdMock.mockReset();
    resolvePluginConfigContractsByIdMock.mockReturnValue(new Map());
  });

  it("collects manifest-declared dangerous plugin config values", () => {
    resolvePluginConfigContractsByIdMock.mockReturnValue(
      new Map([
        [
          "acpx",
          {
            configContracts: {
              dangerousFlags: [{ path: "permissionMode", equals: "approve-all" }],
            },
          },
        ],
      ]),
    );

    expect(
      collectEnabledInsecureOrDangerousFlags(
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
      ),
    ).toContain("plugins.entries.acpx.config.permissionMode=approve-all");
  });

  it("ignores plugin config values that are not declared as dangerous", () => {
    resolvePluginConfigContractsByIdMock.mockReturnValue(
      new Map([
        [
          "other",
          {
            configContracts: {
              dangerousFlags: [{ path: "mode", equals: "danger" }],
            },
          },
        ],
      ]),
    );

    expect(
      collectEnabledInsecureOrDangerousFlags(
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
      ),
    ).toEqual([]);
  });

  it("collects dangerous sandbox, hook, browser, and fs flags", () => {
    expect(
      collectEnabledInsecureOrDangerousFlags(
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
      ),
    ).toEqual(
      expect.arrayContaining([
        "agents.defaults.sandbox.docker.dangerouslyAllowReservedContainerTargets=true",
        "agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true",
        'agents.list[id="worker"].sandbox.docker.dangerouslyAllowExternalBindSources=true',
        "hooks.allowRequestSessionKey=true",
        "browser.ssrfPolicy.dangerouslyAllowPrivateNetwork=true",
        "tools.fs.workspaceOnly=false",
      ]),
    );
  });

  it("uses stable agent ids for per-agent dangerous sandbox flags", () => {
    expect(
      collectEnabledInsecureOrDangerousFlags(
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
      collectEnabledInsecureOrDangerousFlags(
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
