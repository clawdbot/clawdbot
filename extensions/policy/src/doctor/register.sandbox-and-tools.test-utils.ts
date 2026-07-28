// Imported by register.test.ts to keep its mocked suite in one Vitest module graph.
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { runDoctorLintChecks, type OpenClawConfig } from "openclaw/plugin-sdk/health";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectPolicyEvidence } from "../policy-state.js";
import { registerPolicyDoctorChecks } from "./register.js";
import {
  workspaceDir,
  cfgWithPolicy,
  ctx,
  runPolicyChecks,
  describe0BeforeEach0,
  describe0AfterEach1,
} from "./register.test-harness.js";

describe("registerPolicyDoctorChecks", () => {
  beforeEach(describe0BeforeEach0);

  afterEach(describe0AfterEach1);

  it("ignores agent-local Docker and browser posture under shared sandbox scope", async () => {
    const cfg = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            scope: "shared",
            docker: {
              network: "none",
              binds: ["/shared:/shared:ro"],
            },
            browser: {
              enabled: true,
              cdpSourceRange: "172.21.0.1/32",
              binds: ["/browser-shared:/browser-shared:ro"],
            },
          },
        },
        list: [
          {
            id: "runner",
            sandbox: {
              docker: {
                network: "host",
                binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
              },
              browser: {
                cdpSourceRange: "",
                binds: ["/unsafe-browser:/unsafe-browser:rw"],
              },
            },
          },
        ],
      },
    };

    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);
    const runnerEvidence = (evidence.sandboxPosture ?? []).filter(
      (entry) => entry.agentId === "runner",
    );

    expect(runnerEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "containerNetwork",
          value: "none",
          source: "oc://openclaw.config/agents/defaults/sandbox/docker/network",
        }),
        expect.objectContaining({
          kind: "browserCdpSourceRange",
          value: "172.21.0.1/32",
          source: "oc://openclaw.config/agents/defaults/sandbox/browser/cdpSourceRange",
        }),
        expect.objectContaining({
          kind: "containerMount",
          bind: "/shared:/shared:ro",
          source: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#0",
        }),
        expect.objectContaining({
          kind: "containerMount",
          bind: "/browser-shared:/browser-shared:ro",
          source: "oc://openclaw.config/agents/defaults/sandbox/browser/binds/#0",
        }),
      ]),
    );
    expect(runnerEvidence).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bind: "/var/run/docker.sock:/var/run/docker.sock:rw" }),
        expect.objectContaining({ bind: "/unsafe-browser:/unsafe-browser:rw" }),
        expect.objectContaining({
          kind: "containerNetwork",
          value: "host",
        }),
      ]),
    );
  });

  it("treats blank agent browser CDP source range as an explicit clear", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            browser: { enabled: true, cdpSourceRange: "172.21.0.1/32" },
          },
        },
        list: [
          {
            id: "runner",
            sandbox: {
              browser: { cdpSourceRange: "" },
            },
          },
        ],
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: {
          browser: { requireCdpSourceRange: true },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-browser-cdp-source-range-missing",
          ocPath: "oc://openclaw.config/agents/list/#0/sandbox/browser/cdpSourceRange",
        }),
      ]),
    );
  });

  it("reports enabled container posture rules that the backend cannot observe", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "openshell",
            docker: {
              network: "host",
              binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
              seccompProfile: "unconfined",
            },
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: {
          allowBackends: ["openshell"],
          containers: {
            denyHostNetwork: true,
            denyContainerRuntimeSocketMounts: true,
            denyUnconfinedProfiles: true,
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.sandboxPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "backend",
          value: "openshell",
        }),
      ]),
    );
    expect(evidence.sandboxPosture).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "containerNetwork" }),
        expect.objectContaining({ kind: "containerMount" }),
        expect.objectContaining({ kind: "containerSecurityProfile" }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-container-posture-unobservable",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/backend",
          requirement: "oc://policy.jsonc/sandbox/containers/denyHostNetwork",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-posture-unobservable",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/backend",
          requirement: "oc://policy.jsonc/sandbox/containers/denyContainerRuntimeSocketMounts",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-posture-unobservable",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/backend",
          requirement: "oc://policy.jsonc/sandbox/containers/denyUnconfinedProfiles",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "policy/sandbox-container-host-network-denied" }),
        expect.objectContaining({ checkId: "policy/sandbox-container-runtime-socket-mount" }),
        expect.objectContaining({ checkId: "policy/sandbox-container-unconfined-profile" }),
      ]),
    );
  });

  it("evaluates inherited container mounts for browser containers on non-Docker backends", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "openshell",
            docker: {
              binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
            },
            browser: {
              enabled: true,
              cdpSourceRange: "172.21.0.1/32",
            },
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: {
          allowBackends: ["openshell"],
          containers: {
            requireReadOnlyMounts: true,
            denyContainerRuntimeSocketMounts: true,
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.sandboxPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "containerMount",
          bindSurface: "browser",
          bind: "/var/run/docker.sock:/var/run/docker.sock:rw",
          source: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#0",
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-container-mount-mode-required",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#0",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-runtime-socket-mount",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#0",
        }),
      ]),
    );
  });

  it("normalizes mixed-case Docker backend before collecting container posture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "Docker",
            docker: {
              network: "host",
              binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
              seccompProfile: "unconfined",
            },
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: {
          allowBackends: ["docker"],
          containers: {
            denyHostNetwork: true,
            denyContainerRuntimeSocketMounts: true,
            denyUnconfinedProfiles: true,
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.sandboxPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "backend", value: "docker" }),
        expect.objectContaining({ kind: "containerNetwork", value: "host" }),
        expect.objectContaining({ kind: "containerMount" }),
        expect.objectContaining({
          kind: "containerSecurityProfile",
          profile: "seccomp",
          value: "unconfined",
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "policy/sandbox-container-host-network-denied" }),
        expect.objectContaining({ checkId: "policy/sandbox-container-runtime-socket-mount" }),
        expect.objectContaining({ checkId: "policy/sandbox-container-unconfined-profile" }),
      ]),
    );
  });

  it("uses explicit agent sandbox scope before inherited legacy perSession", async () => {
    const cfg = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            perSession: false,
            docker: {
              network: "none",
            },
          },
        },
        list: [
          {
            id: "runner",
            sandbox: {
              scope: "agent",
              docker: {
                network: "host",
                binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
              },
              browser: {
                enabled: true,
                cdpSourceRange: "172.21.0.1/32",
                binds: ["/browser:/browser:rw"],
              },
            },
          },
        ],
      },
    };

    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);
    const runnerEvidence = (evidence.sandboxPosture ?? []).filter(
      (entry) => entry.agentId === "runner",
    );

    expect(runnerEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "containerNetwork",
          value: "host",
          source: "oc://openclaw.config/agents/list/#0/sandbox/docker/network",
        }),
        expect.objectContaining({
          kind: "containerMount",
          bind: "/var/run/docker.sock:/var/run/docker.sock:rw",
          source: "oc://openclaw.config/agents/list/#0/sandbox/docker/binds/#0",
        }),
        expect.objectContaining({
          kind: "containerMount",
          bind: "/browser:/browser:rw",
          source: "oc://openclaw.config/agents/list/#0/sandbox/browser/binds/#0",
        }),
      ]),
    );
  });

  it("accepts configured sandbox posture that matches policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            docker: {
              network: "none",
              binds: ["/data:/data:ro"],
              seccompProfile: "runtime/default",
            },
            browser: { enabled: true, cdpSourceRange: "172.21.0.1/32" },
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: {
          requireMode: ["all", "non-main"],
          allowBackends: ["docker"],
          containers: {
            denyHostNetwork: true,
            denyContainerNamespaceJoin: true,
            requireReadOnlyMounts: true,
            denyContainerRuntimeSocketMounts: true,
            denyUnconfinedProfiles: true,
          },
          browser: { requireCdpSourceRange: true },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("applies agent-scoped sandbox claims only to matching agents", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        list: [
          { id: "Sebby", sandbox: { mode: "off", backend: "ssh" } },
          { id: "buddy", sandbox: { mode: "all", backend: "docker" } },
        ],
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: {
          requireMode: ["all"],
        },
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            sandbox: {
              allowBackends: ["docker"],
            },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-mode-unapproved",
          ocPath: "oc://openclaw.config/agents/list/#0/sandbox/mode",
          requirement: "oc://policy.jsonc/sandbox/requireMode",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-backend-unapproved",
          ocPath: "oc://openclaw.config/agents/list/#0/sandbox/backend",
          requirement: "oc://policy.jsonc/scopes/sebby/sandbox/allowBackends",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ocPath: "oc://openclaw.config/agents/list/#1/sandbox/backend",
          requirement: "oc://policy.jsonc/scopes/sebby/sandbox/allowBackends",
        }),
      ]),
    );
  });

  it("does not apply sandbox overlays from invalid scoped policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        list: [{ id: "sebby", sandbox: { mode: "off" } }],
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            channels: { allow: ["discord"] },
            sandbox: {
              requireMode: ["all"],
            },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/policy-jsonc-invalid",
          target: "oc://policy.jsonc/scopes/sebby/channels",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-mode-unapproved",
          requirement: "oc://policy.jsonc/scopes/sebby/sandbox/requireMode",
        }),
      ]),
    );
  });

  it("reports scoped container posture rules that a non-Docker agent group cannot observe", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            docker: {
              network: "none",
              binds: ["/workspace:/workspace:rw"],
            },
          },
        },
        list: [
          {
            id: "release-agent",
            sandbox: { mode: "all", backend: "openshell" },
          },
        ],
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          release: {
            agentIds: ["release-agent"],
            sandbox: {
              containers: { requireReadOnlyMounts: true },
            },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/sandbox-container-posture-unobservable",
        ocPath: "oc://openclaw.config/agents/list/#0/sandbox/backend",
        requirement: "oc://policy.jsonc/scopes/release/sandbox/containers/requireReadOnlyMounts",
      }),
    ]);
  });

  it("allows scoped non-Docker agent groups when container posture rules are off", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            docker: {
              network: "none",
              binds: ["/workspace:/workspace:rw"],
            },
          },
        },
        list: [
          {
            id: "release-agent",
            sandbox: { mode: "all", backend: "openshell" },
          },
        ],
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          release: {
            agentIds: ["release-agent"],
            sandbox: {
              containers: { requireReadOnlyMounts: false },
            },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("does not fall back to default browser posture for scoped browser-disabled agents", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            browser: { enabled: true, network: "host" },
          },
        },
        list: [
          {
            id: "release-agent",
            sandbox: { browser: { enabled: false } },
          },
        ],
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          release: {
            agentIds: ["release-agent"],
            sandbox: {
              containers: { denyHostNetwork: true },
              browser: { requireCdpSourceRange: true },
            },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.sandboxPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "release-agent",
          kind: "browserCdpSourceRange",
          value: false,
        }),
        expect.objectContaining({
          kind: "containerNetwork",
          networkSurface: "browser",
          value: "host",
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("applies main-scoped sandbox claims to defaults when unrelated agents exist", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: { mode: "off" },
        },
        list: [
          {
            id: "worker",
            sandbox: { mode: "all" },
          },
        ],
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          mainSandbox: {
            agentIds: ["main"],
            sandbox: { requireMode: ["all"] },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-mode-unapproved",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/mode",
          requirement: "oc://policy.jsonc/scopes/mainSandbox/sandbox/requireMode",
        }),
      ]),
    );
  });

  it("reports tool posture denied by policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        profile: "coding",
        deny: ["write"],
        exec: { security: "full", ask: "off", host: "gateway" },
        fs: { workspaceOnly: false },
        elevated: { enabled: true, allowFrom: { whatsapp: ["+15550000001", 15550000002] } },
      },
      agents: {
        list: [
          {
            id: "reviewer",
            tools: {
              profile: "messaging",
              deny: ["group:runtime", "group:fs"],
              exec: { security: "deny", ask: "always", host: "sandbox" },
              fs: { workspaceOnly: true },
              elevated: { enabled: false },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          profiles: { allow: ["messaging", "minimal"] },
          fs: { requireWorkspaceOnly: true },
          exec: {
            allowSecurity: ["deny", "allowlist"],
            requireAsk: ["always"],
            allowHosts: ["sandbox"],
          },
          elevated: { allow: false },
          denyTools: ["exec", "write", "edit", "apply_patch"],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.toolPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tools-profile",
          kind: "profile",
          value: "coding",
          source: "oc://openclaw.config/tools/profile",
        }),
        expect.objectContaining({
          id: "reviewer-exec-security",
          kind: "execSecurity",
          value: "deny",
          source: "oc://openclaw.config/agents/list/#0/tools/exec/security",
        }),
        expect.objectContaining({
          id: "tools-elevated-allow-from-whatsapp",
          kind: "elevatedAllowFrom",
          entries: ["+15550000001", "15550000002"],
          source: "oc://openclaw.config/tools/elevated/allowFrom/whatsapp",
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-profile-unapproved",
          severity: "error",
          ocPath: "oc://openclaw.config/tools/profile",
          requirement: "oc://policy.jsonc/tools/profiles/allow",
        }),
        expect.objectContaining({
          checkId: "policy/tools-fs-workspace-only-required",
          ocPath: "oc://openclaw.config/tools/fs/workspaceOnly",
          requirement: "oc://policy.jsonc/tools/fs/requireWorkspaceOnly",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-security-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/security",
          requirement: "oc://policy.jsonc/tools/exec/allowSecurity",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-ask-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/ask",
          requirement: "oc://policy.jsonc/tools/exec/requireAsk",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-host-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/host",
          requirement: "oc://policy.jsonc/tools/exec/allowHosts",
        }),
        expect.objectContaining({
          checkId: "policy/tools-elevated-enabled",
          ocPath: "oc://openclaw.config/tools/elevated/enabled",
          requirement: "oc://policy.jsonc/tools/elevated/allow",
        }),
        expect.objectContaining({
          checkId: "policy/tools-required-deny-missing",
          ocPath: "oc://openclaw.config/tools/deny",
          requirement: "oc://policy.jsonc/tools/denyTools",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-required-deny-missing",
          ocPath: "oc://openclaw.config/agents/list/#0/tools/deny",
        }),
      ]),
    );
  });

  it("accepts configured tool posture that matches policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        profile: "messaging",
        deny: ["group:runtime", "group:fs"],
        exec: { security: "deny", ask: "always", host: "sandbox" },
        fs: { workspaceOnly: true },
        elevated: { enabled: false },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          profiles: { allow: ["messaging", "minimal"] },
          fs: { requireWorkspaceOnly: true },
          exec: {
            allowSecurity: ["deny"],
            requireAsk: ["always"],
            allowHosts: ["sandbox"],
          },
          elevated: { allow: false },
          denyTools: ["exec", "write", "edit", "apply_patch"],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports global and agent-scoped tool claims independently", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        exec: { host: "sandbox" },
      },
      agents: {
        list: [
          { id: "sebby", tools: { exec: { host: "node" } } },
          { id: "buddy", tools: { exec: { host: "sandbox" } } },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          exec: { allowHosts: ["sandbox", "gateway"] },
        },
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            tools: {
              exec: { allowHosts: ["gateway"] },
            },
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-exec-host-unapproved",
          ocPath: "oc://openclaw.config/agents/list/#0/tools/exec/host",
          requirement: "oc://policy.jsonc/tools/exec/allowHosts",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-host-unapproved",
          ocPath: "oc://openclaw.config/agents/list/#0/tools/exec/host",
          requirement: "oc://policy.jsonc/scopes/sebby/tools/exec/allowHosts",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ocPath: "oc://openclaw.config/agents/list/#1/tools/exec/host",
        }),
      ]),
    );
  });

  it("does not apply agent-scoped tool claims to other agents", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        list: [
          { id: "sebby", tools: { exec: { host: "sandbox" } } },
          { id: "buddy", tools: { exec: { host: "node" } } },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            tools: {
              exec: { allowHosts: ["sandbox"] },
            },
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports global and agent-scoped alsoAllow drift", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: { alsoAllow: ["read", "cron"] },
      agents: {
        list: [
          { id: "sebby", tools: { alsoAllow: ["read", "gateway"] } },
          { id: "buddy", tools: { alsoAllow: ["read"] } },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          alsoAllow: { expected: ["read", "message"] },
        },
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            tools: {
              alsoAllow: { expected: ["read", "message"] },
            },
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-also-allow-missing",
          ocPath: "oc://openclaw.config/tools/alsoAllow",
          requirement: "oc://policy.jsonc/tools/alsoAllow/expected",
        }),
        expect.objectContaining({
          checkId: "policy/tools-also-allow-unexpected",
          ocPath: "oc://openclaw.config/tools/alsoAllow",
          requirement: "oc://policy.jsonc/tools/alsoAllow/expected",
        }),
        expect.objectContaining({
          checkId: "policy/tools-also-allow-missing",
          ocPath: "oc://openclaw.config/agents/list/#0/tools/alsoAllow",
          requirement: "oc://policy.jsonc/scopes/sebby/tools/alsoAllow/expected",
        }),
        expect.objectContaining({
          checkId: "policy/tools-also-allow-unexpected",
          ocPath: "oc://openclaw.config/agents/list/#0/tools/alsoAllow",
          requirement: "oc://policy.jsonc/scopes/sebby/tools/alsoAllow/expected",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requirement: "oc://policy.jsonc/scopes/sebby/tools/alsoAllow/expected",
          ocPath: "oc://openclaw.config/agents/list/#1/tools/alsoAllow",
        }),
      ]),
    );
  });

  it("reports unexpected alsoAllow entries when policy expects none", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: { alsoAllow: ["read"] },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          alsoAllow: { expected: [] },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/tools-also-allow-unexpected",
        ocPath: "oc://openclaw.config/tools/alsoAllow",
        requirement: "oc://policy.jsonc/tools/alsoAllow/expected",
      }),
    ]);
  });

  it("uses config-level exec defaults and normalizes required deny aliases", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        deny: ["exec", "apply_patch"],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          exec: {
            allowSecurity: ["deny"],
            requireAsk: ["always"],
            allowHosts: ["auto"],
          },
          denyTools: ["bash", "apply-patch"],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-exec-security-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/security",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-ask-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/ask",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-required-deny-missing",
        }),
      ]),
    );
  });

  it("accepts omitted exec defaults and individual denies for required deny groups", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        deny: ["exec", "process", "code_execution", "read", "write", "edit", "apply_patch"],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          exec: {
            allowSecurity: ["full"],
            requireAsk: ["off"],
            allowHosts: ["auto"],
          },
          denyTools: ["group:runtime", "group:fs"],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("accepts wildcard tool denies for required tool posture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        deny: ["web_*"],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          denyTools: ["web_search"],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("accepts canonical tool groups for required tool denies", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        deny: ["group:openclaw"],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          denyTools: ["message"],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.toolPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tools-deny",
          kind: "deny",
          entries: ["group:openclaw"],
          source: "oc://openclaw.config/tools/deny",
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("treats globally disabled elevated mode as disabling per-agent elevated posture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        elevated: { enabled: false },
      },
      agents: {
        list: [
          {
            id: "reviewer",
            tools: {
              elevated: { enabled: true },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          elevated: { allow: false },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.toolPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "reviewer-elevated-enabled",
          kind: "elevatedEnabled",
          value: false,
          source: "oc://openclaw.config/tools/elevated/enabled",
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("treats omitted tool profile as full posture for profile allow policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = cfgWithPolicy();
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          profiles: { allow: ["messaging"] },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/tools-profile-unapproved",
        ocPath: "oc://openclaw.config/tools/profile",
        requirement: "oc://policy.jsonc/tools/profiles/allow",
      }),
    ]);
  });

  it("uses deny as the omitted exec security default for explicit sandbox host", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        exec: { host: "sandbox" },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          exec: {
            allowSecurity: ["deny"],
            allowHosts: ["sandbox"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.toolPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tools-exec-security",
          kind: "execSecurity",
          value: "deny",
          source: "oc://openclaw.config/tools/exec/security",
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("uses deny as the omitted exec security default for auto host when sandbox can apply", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: { mode: "all" },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          exec: {
            allowSecurity: ["deny"],
            allowHosts: ["auto"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.toolPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tools-exec-security",
          kind: "execSecurity",
          value: "deny",
          source: "oc://openclaw.config/tools/exec/security",
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("keeps omitted auto-host exec security full when sandbox is non-main only", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: { mode: "non-main" },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          exec: {
            allowSecurity: ["deny"],
            allowHosts: ["auto"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.toolPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tools-exec-security",
          kind: "execSecurity",
          value: "full",
          source: "oc://openclaw.config/tools/exec/security",
        }),
      ]),
    );
    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/tools-exec-security-unapproved",
        ocPath: "oc://openclaw.config/tools/exec/security",
        requirement: "oc://policy.jsonc/tools/exec/allowSecurity",
      }),
    ]);
  });

  it("reports gateway exposure settings denied by policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        bind: "lan",
        auth: { mode: "none" },
        controlUi: {
          dangerouslyAllowHostHeaderOriginFallback: true,
        },
        tailscale: { mode: "funnel" },
        mode: "remote",
        http: {
          endpoints: {
            chatCompletions: {
              enabled: true,
              images: { allowUrl: true },
            },
            responses: {
              enabled: true,
              files: { allowUrl: true },
              images: { allowUrl: true, urlAllowlist: ["images.example.test"] },
            },
          },
        },
        nodes: {
          commands: { allow: ["mcp.help", "mcp.invoke", "system.run"] },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          exposure: {
            allowNonLoopbackBind: false,
            allowTailscaleFunnel: false,
          },
          auth: {
            requireAuth: true,
            requireExplicitRateLimit: true,
          },
          controlUi: {
            allowInsecure: false,
          },
          remote: {
            allow: false,
          },
          http: {
            denyEndpoints: ["chatCompletions", "responses"],
            requireUrlAllowlists: true,
          },
          nodes: {
            denyCommands: ["system.run"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/gateway-non-loopback-bind",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/bind",
          requirement: "oc://policy.jsonc/gateway/exposure/allowNonLoopbackBind",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-auth-disabled",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/auth/mode",
          requirement: "oc://policy.jsonc/gateway/auth/requireAuth",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-rate-limit-missing",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/auth/rateLimit",
          requirement: "oc://policy.jsonc/gateway/auth/requireExplicitRateLimit",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-tailscale-funnel",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/tailscale/mode",
          requirement: "oc://policy.jsonc/gateway/exposure/allowTailscaleFunnel",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-remote-enabled",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/mode",
          requirement: "oc://policy.jsonc/gateway/remote/allow",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-http-endpoint-enabled",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/chatCompletions/enabled",
          requirement: "oc://policy.jsonc/gateway/http/denyEndpoints",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-http-url-fetch-unrestricted",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/chatCompletions/images/allowUrl",
          requirement: "oc://policy.jsonc/gateway/http/requireUrlAllowlists",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-node-command-denied",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/nodes/commands/deny",
          requirement: "oc://policy.jsonc/gateway/nodes/denyCommands",
        }),
      ]),
    );
    expect(result.findings).toHaveLength(11);
  });

  it("does not report gateway node commands denied by runtime config", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        nodes: {
          commands: {
            allow: ["system.run"],
            deny: ["system.run"],
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          nodes: {
            denyCommands: ["system.run"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports gateway node commands denied by policy without explicit extra allows", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        nodes: {},
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          nodes: {
            denyCommands: ["system.run"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-node-command-denied",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/nodes/commands/deny",
        requirement: "oc://policy.jsonc/gateway/nodes/denyCommands",
      }),
    ]);
  });

  it("reports omitted gateway bind when non-loopback exposure is denied", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {},
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          exposure: {
            allowNonLoopbackBind: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-non-loopback-bind",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/bind",
        requirement: "oc://policy.jsonc/gateway/exposure/allowNonLoopbackBind",
      }),
    ]);
  });

  it("does not report omitted gateway bind when Tailscale forces loopback", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        tailscale: { mode: "serve" },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          exposure: {
            allowNonLoopbackBind: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports preserved Tailscale Funnel routes when policy denies Funnel exposure", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        tailscale: { mode: "serve", preserveFunnel: true },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          exposure: {
            allowTailscaleFunnel: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-tailscale-funnel",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/tailscale/preserveFunnel",
        requirement: "oc://policy.jsonc/gateway/exposure/allowTailscaleFunnel",
      }),
    ]);
  });

  it("reports missing gateway rate limits when gateway config is omitted", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          auth: {
            requireExplicitRateLimit: true,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-rate-limit-missing",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/auth/rateLimit",
        requirement: "oc://policy.jsonc/gateway/auth/requireExplicitRateLimit",
      }),
    ]);
  });

  it("does not report inactive custom bind hosts", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        bind: "loopback",
        customBindHost: "0.0.0.0",
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          exposure: {
            allowNonLoopbackBind: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("does not report loopback custom bind hosts", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        bind: "custom",
        customBindHost: "127.0.0.1",
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          exposure: {
            allowNonLoopbackBind: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports valid non-loopback custom bind hosts", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        bind: "custom",
        customBindHost: "192.168.1.20",
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          exposure: {
            allowNonLoopbackBind: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-non-loopback-bind",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/customBindHost",
        requirement: "oc://policy.jsonc/gateway/exposure/allowNonLoopbackBind",
      }),
    ]);
  });

  it("does not report blank custom bind config as active non-loopback exposure", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        bind: "custom",
        customBindHost: "   ",
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          exposure: {
            allowNonLoopbackBind: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it.each(["localhost", "::1", "192.168.001.20"])(
    "does not report invalid custom bind host %s as active non-loopback exposure",
    async (customBindHost) => {
      const configPath = join(workspaceDir, "openclaw.jsonc");
      const cfg = {
        ...cfgWithPolicy(),
        gateway: {
          bind: "custom",
          customBindHost,
        },
      } as unknown as OpenClawConfig;
      await fs.writeFile(configPath, "{}", "utf-8");
      await fs.writeFile(
        join(workspaceDir, "policy.jsonc"),
        JSON.stringify({
          gateway: {
            exposure: {
              allowNonLoopbackBind: false,
            },
          },
        }),
        "utf-8",
      );

      registerPolicyDoctorChecks();
      const result = await runDoctorLintChecks(ctx(configPath, cfg));

      expect(result.findings).toEqual([]);
    },
  );

  it("reports configured gateway remote URLs when remote mode is active", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://remote.example.test:18789",
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          remote: {
            allow: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-remote-enabled",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/mode",
        requirement: "oc://policy.jsonc/gateway/remote/allow",
      }),
      expect.objectContaining({
        checkId: "policy/gateway-remote-enabled",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/remote/url",
        requirement: "oc://policy.jsonc/gateway/remote/allow",
      }),
    ]);
  });

  it("does not report inert remote config outside remote mode", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        remote: {
          url: "wss://remote.example.test:18789",
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          remote: {
            allow: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports default Responses URL fetching without allowlists", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        http: {
          endpoints: {
            responses: {
              enabled: true,
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          http: {
            requireUrlAllowlists: true,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/gateway-http-url-fetch-unrestricted",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/responses/files/allowUrl",
          requirement: "oc://policy.jsonc/gateway/http/requireUrlAllowlists",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-http-url-fetch-unrestricted",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/responses/images/allowUrl",
          requirement: "oc://policy.jsonc/gateway/http/requireUrlAllowlists",
        }),
      ]),
    );
    expect(result.findings).toHaveLength(2);
  });

  it("reports wildcard Responses URL allowlists as unrestricted", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        http: {
          endpoints: {
            responses: {
              enabled: true,
              files: { urlAllowlist: ["*"] },
              images: { urlAllowlist: ["*."] },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          http: {
            requireUrlAllowlists: true,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/gateway-http-url-fetch-unrestricted",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/responses/files/allowUrl",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-http-url-fetch-unrestricted",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/responses/images/allowUrl",
        }),
      ]),
    );
    expect(result.findings).toHaveLength(2);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
