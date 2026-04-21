import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectEnabledInsecureOrDangerousFlags } from "./dangerous-config-flags.js";

const { loadPluginManifestRegistryMock } = vi.hoisted(() => ({
  loadPluginManifestRegistryMock: vi.fn(),
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: loadPluginManifestRegistryMock,
}));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("collectEnabledInsecureOrDangerousFlags", () => {
  beforeEach(() => {
    loadPluginManifestRegistryMock.mockReset();
  });

  it("collects manifest-declared dangerous plugin config values", () => {
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        {
          id: "acpx",
          configContracts: {
            dangerousFlags: [{ path: "permissionMode", equals: "approve-all" }],
          },
        },
      ],
      diagnostics: [],
    });

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
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        {
          id: "other",
          configContracts: {
            dangerousFlags: [{ path: "mode", equals: "danger" }],
          },
        },
      ],
      diagnostics: [],
    });

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
