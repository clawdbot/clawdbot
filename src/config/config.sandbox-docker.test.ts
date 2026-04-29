import { describe, expect, it } from "vitest";
import {
  DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS,
  resolveSandboxBrowserConfig,
  resolveSandboxDockerConfig,
} from "../agents/sandbox/config.js";
import { validateConfigObject } from "./validation.js";

describe("sandbox docker config", () => {
  it("joins setupCommand arrays with newlines", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              setupCommand: ["apt-get update", "apt-get install -y curl"],
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.defaults?.sandbox?.docker?.setupCommand).toBe(
        "apt-get update\napt-get install -y curl",
      );
    }
  });

  it("accepts safe binds array in sandbox.docker config", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              binds: ["/home/user/source:/source:rw", "/var/data/myapp:/data:ro"],
            },
          },
        },
        list: [
          {
            id: "main",
            sandbox: {
              docker: {
                image: "custom-sandbox:latest",
                binds: ["/home/user/projects:/projects:ro"],
              },
            },
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.defaults?.sandbox?.docker?.binds).toEqual([
        "/home/user/source:/source:rw",
        "/var/data/myapp:/data:ro",
      ]);
      expect(res.config.agents?.list?.[0]?.sandbox?.docker?.binds).toEqual([
        "/home/user/projects:/projects:ro",
      ]);
    }
  });

  it("accepts non-empty Docker GPU passthrough config", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              gpus: "all",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.defaults?.sandbox?.docker?.gpus).toBe("all");
    }
  });

  it("rejects empty Docker GPU passthrough config", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              gpus: "",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("rejects network host mode via Zod schema validation", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              network: "host",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("rejects container namespace join by default", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              network: "container:peer",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("allows container namespace join with explicit dangerous override", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              network: "container:peer",
              dangerouslyAllowContainerNamespaceJoin: true,
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("uses agent override precedence for dangerous sandbox docker booleans", () => {
    for (const key of DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS) {
      const inherited = resolveSandboxDockerConfig({
        scope: "agent",
        globalDocker: { [key]: true },
        agentDocker: {},
      });
      expect(inherited[key]).toBe(true);

      const overridden = resolveSandboxDockerConfig({
        scope: "agent",
        globalDocker: { [key]: true },
        agentDocker: { [key]: false },
      });
      expect(overridden[key]).toBe(false);

      const sharedScope = resolveSandboxDockerConfig({
        scope: "shared",
        globalDocker: { [key]: true },
        agentDocker: { [key]: false },
      });
      expect(sharedScope[key]).toBe(true);
    }
  });

  it("rejects seccomp unconfined via Zod schema validation", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              seccompProfile: "unconfined",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("rejects apparmor unconfined via Zod schema validation", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              apparmorProfile: "unconfined",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("rejects non-string values in binds array", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              binds: [123, "/valid/path:/path"],
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });
});

describe("sandbox browser binds config", () => {
  it("accepts binds array in sandbox.browser config", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            browser: {
              binds: ["/home/user/.chrome-profile:/data/chrome:rw"],
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.defaults?.sandbox?.browser?.binds).toEqual([
        "/home/user/.chrome-profile:/data/chrome:rw",
      ]);
    }
  });

  it("rejects non-string values in browser binds array", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            browser: {
              binds: [123],
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("merges global and agent browser binds", () => {
    const resolved = resolveSandboxBrowserConfig({
      scope: "agent",
      globalBrowser: { binds: ["/global:/global:ro"] },
      agentBrowser: { binds: ["/agent:/agent:rw"] },
    });
    expect(resolved.binds).toEqual(["/global:/global:ro", "/agent:/agent:rw"]);
  });

  it("treats empty binds as configured (override to none)", () => {
    const resolved = resolveSandboxBrowserConfig({
      scope: "agent",
      globalBrowser: { binds: [] },
      agentBrowser: {},
    });
    expect(resolved.binds).toEqual([]);
  });

  it("ignores agent browser binds under shared scope", () => {
    const resolved = resolveSandboxBrowserConfig({
      scope: "shared",
      globalBrowser: { binds: ["/global:/global:ro"] },
      agentBrowser: { binds: ["/agent:/agent:rw"] },
    });
    expect(resolved.binds).toEqual(["/global:/global:ro"]);

    const resolvedNoGlobal = resolveSandboxBrowserConfig({
      scope: "shared",
      globalBrowser: {},
      agentBrowser: { binds: ["/agent:/agent:rw"] },
    });
    expect(resolvedNoGlobal.binds).toBeUndefined();
  });

  it("returns undefined binds when none configured", () => {
    const resolved = resolveSandboxBrowserConfig({
      scope: "agent",
      globalBrowser: {},
      agentBrowser: {},
    });
    expect(resolved.binds).toBeUndefined();
  });

  it("defaults browser network to dedicated sandbox network", () => {
    const resolved = resolveSandboxBrowserConfig({
      scope: "agent",
      globalBrowser: {},
      agentBrowser: {},
    });
    expect(resolved.network).toBe("openclaw-sandbox-browser");
  });

  it("prefers agent browser network over global browser network", () => {
    const resolved = resolveSandboxBrowserConfig({
      scope: "agent",
      globalBrowser: { network: "openclaw-sandbox-browser-global" },
      agentBrowser: { network: "openclaw-sandbox-browser-agent" },
    });
    expect(resolved.network).toBe("openclaw-sandbox-browser-agent");
  });

  it("merges cdpSourceRange with agent override", () => {
    const resolved = resolveSandboxBrowserConfig({
      scope: "agent",
      globalBrowser: { cdpSourceRange: "172.21.0.1/32" },
      agentBrowser: { cdpSourceRange: "172.22.0.1/32" },
    });
    expect(resolved.cdpSourceRange).toBe("172.22.0.1/32");
  });

  it("rejects host network mode in sandbox.browser config", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            browser: {
              network: "host",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("rejects container namespace join in sandbox.browser config by default", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            browser: {
              network: "container:peer",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("allows container namespace join in sandbox.browser config with explicit dangerous override", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              dangerouslyAllowContainerNamespaceJoin: true,
            },
            browser: {
              network: "container:peer",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });
});
