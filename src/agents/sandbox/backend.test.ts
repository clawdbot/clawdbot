// Sandbox backend registry tests cover pluggable backend factory and manager
// lifecycle hooks.
import { describe, expect, it } from "vitest";
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
