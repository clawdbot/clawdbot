// Sandbox backend registry tests cover pluggable backend factory and manager
// lifecycle hooks.
import { describe, expect, it, vi } from "vitest";
import {
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendWorkdirResolver,
  registerSandboxBackend,
} from "./backend.js";

function createGenerationRegistration(label: string) {
  return {
    factory: async () => {
      throw new Error(`unused sandbox backend ${label}`);
    },
    manager: {
      describeRuntime: async () => ({ running: true, configLabelMatch: true }),
      removeRuntime: async () => {},
    },
    resolveWorkdir: () => `/runtime/${label}`,
  };
}

describe("sandbox backend registry", () => {
  it("registers Podman as a built-in backend", () => {
    expect(getSandboxBackendFactory("podman")).not.toBeNull();
    expect(getSandboxBackendManager("podman")).not.toBeNull();
    expect(getSandboxBackendWorkdirResolver("podman")).not.toBeNull();
  });

  it.each(["docker", "podman", "ssh"] as const)(
    "preserves %s overrides through repeated module reloads and restores its defaults",
    async (backendId) => {
      const defaults = {
        factory: getSandboxBackendFactory(backendId),
        manager: getSandboxBackendManager(backendId),
        resolveWorkdir: getSandboxBackendWorkdirResolver(backendId),
      };
      const registration = createGenerationRegistration(backendId);
      const restore = registerSandboxBackend(backendId, registration);

      try {
        for (let reload = 0; reload < 2; reload++) {
          vi.resetModules();
          const fresh = await import("./backend.js");
          expect(fresh.getSandboxBackendFactory(backendId)).toBe(registration.factory);
          expect(fresh.getSandboxBackendManager(backendId)).toBe(registration.manager);
          expect(fresh.getSandboxBackendWorkdirResolver(backendId)).toBe(
            registration.resolveWorkdir,
          );
        }
      } finally {
        restore();
      }

      expect(getSandboxBackendFactory(backendId)).toBe(defaults.factory);
      expect(getSandboxBackendManager(backendId)).toBe(defaults.manager);
      expect(getSandboxBackendWorkdirResolver(backendId)).toBe(defaults.resolveWorkdir);

      const fresh = await import("./backend.js");
      const container = await import("./docker-backend.js");
      const ssh = await import("./ssh-backend.js");
      const { resolveSandboxConfigForAgent } = await import("./config.js");
      const [factory, manager] = {
        docker: [container.createDockerSandboxBackend, container.dockerSandboxBackendManager],
        podman: [container.createPodmanSandboxBackend, container.podmanSandboxBackendManager],
        ssh: [ssh.createSshSandboxBackend, ssh.sshSandboxBackendManager],
      }[backendId];
      expect(fresh.getSandboxBackendFactory(backendId)).toBe(factory);
      expect(fresh.getSandboxBackendManager(backendId)).toBe(manager);
      const cfg = resolveSandboxConfigForAgent();
      const scopeKey = "agent:registry-test:main";
      const workdir = fresh.getSandboxBackendWorkdirResolver(backendId)?.({
        cfg,
        sessionKey: scopeKey,
        scopeKey,
        workspaceDir: "/workspace",
        agentWorkspaceDir: "/workspace",
      });
      expect(workdir).toBe(
        backendId === "ssh"
          ? ssh.resolveSshRuntimePaths(cfg.ssh.workspaceRoot, scopeKey).remoteWorkspaceDir
          : cfg.docker.workdir,
      );
    },
  );

  it("does not inherit built-in management hooks for a factory-only override", () => {
    const registration = createGenerationRegistration("docker");
    const restore = registerSandboxBackend("docker", registration.factory);
    try {
      expect(getSandboxBackendFactory("docker")).toBe(registration.factory);
      expect(getSandboxBackendManager("docker")).toBeNull();
      expect(getSandboxBackendWorkdirResolver("docker")).toBeNull();
    } finally {
      restore();
    }
  });

  it("registers and restores backend factories", () => {
    // Tests and optional backends install process-local factories; restore must
    // remove them so later suites see the default registry.
    const factory = async () => {
      throw new Error("not used");
    };
    const restore = registerSandboxBackend("test-backend", factory);
    expect(getSandboxBackendFactory("test-backend")).toBe(factory);
    restore();
    expect(getSandboxBackendFactory("test-backend")).toBeNull();
  });

  it("registers backend managers alongside factories", () => {
    const factory = async () => {
      throw new Error("not used");
    };
    const manager = {
      describeRuntime: async () => ({
        running: true,
        configLabelMatch: true,
      }),
      removeRuntime: async () => {},
    };
    const restore = registerSandboxBackend("test-managed", {
      factory,
      manager,
    });
    expect(getSandboxBackendFactory("test-managed")).toBe(factory);
    expect(getSandboxBackendManager("test-managed")).toBe(manager);
    restore();
    expect(getSandboxBackendManager("test-managed")).toBeNull();
  });

  it("registers backend workdir resolvers alongside factories", () => {
    const factory = async () => {
      throw new Error("not used");
    };
    const resolveWorkdir = () => "/runtime/workspace";
    const restore = registerSandboxBackend("test-workdir", {
      factory,
      resolveWorkdir,
    });
    expect(getSandboxBackendWorkdirResolver("test-workdir")).toBe(resolveWorkdir);
    restore();
    expect(getSandboxBackendWorkdirResolver("test-workdir")).toBeNull();
  });

  it.each([
    {
      scenario: "older registration retires first",
      generations: ["A", "B"],
      disposalOrder: [
        ["A", "B"],
        ["B", null],
      ],
    },
    {
      scenario: "active registration restores its live predecessor",
      generations: ["A", "B"],
      disposalOrder: [
        ["B", "A"],
        ["A", null],
      ],
    },
    {
      scenario: "active registration skips every retired predecessor",
      generations: ["A", "B", "C"],
      disposalOrder: [
        ["B", "C"],
        ["A", "C"],
        ["C", null],
      ],
    },
    {
      scenario: "active registration restores the newest unretired predecessor",
      generations: ["A", "B", "C"],
      disposalOrder: [
        ["B", "C"],
        ["C", "A"],
        ["A", null],
      ],
    },
    {
      scenario: "repeated stale disposal never restores retired authority",
      generations: ["A", "B"],
      disposalOrder: [
        ["B", "A"],
        ["A", null],
        ["B", null],
      ],
    },
  ] as const)(
    "preserves all backend authority when $scenario",
    ({ generations, disposalOrder }) => {
      const backendId = "test-generation-ownership";
      const registrations = new Map<string, ReturnType<typeof createGenerationRegistration>>();
      const disposers = new Map<string, () => void>();

      try {
        for (const label of generations) {
          const registration = createGenerationRegistration(label);
          registrations.set(label, registration);
          disposers.set(label, registerSandboxBackend(backendId, registration));
        }

        for (const [disposedLabel, expectedLabel] of disposalOrder) {
          const dispose = disposers.get(disposedLabel);
          if (!dispose) {
            throw new Error(`missing sandbox registration disposer ${disposedLabel}`);
          }
          dispose();

          const expected = expectedLabel ? registrations.get(expectedLabel) : undefined;
          expect(getSandboxBackendFactory(backendId)).toBe(expected?.factory ?? null);
          expect(getSandboxBackendManager(backendId)).toBe(expected?.manager ?? null);
          expect(getSandboxBackendWorkdirResolver(backendId)).toBe(
            expected?.resolveWorkdir ?? null,
          );
        }
      } finally {
        for (const dispose of Array.from(disposers.values()).toReversed()) {
          dispose();
        }
      }
    },
  );
});
