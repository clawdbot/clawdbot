import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderPlugin } from "../plugins/types.js";
import {
  arrangeLegacyStateMigrationTest,
  confirm,
  createDoctorRuntime,
  ensureAuthProfileStore,
  mockDoctorConfigSnapshot,
  serviceIsLoaded,
  serviceRestart,
  writeConfigFile,
} from "./doctor.e2e-harness.js";

const providerRuntimeMocks = vi.hoisted(() => ({
  resolvePluginProviders: vi.fn((_params?: unknown): ProviderPlugin[] => []),
}));

vi.mock("../plugins/providers.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/providers.runtime.js")>(
    "../plugins/providers.runtime.js",
  );
  return {
    ...actual,
    resolvePluginProviders: providerRuntimeMocks.resolvePluginProviders,
  };
});

let doctorCommand: typeof import("./doctor.js").doctorCommand;
let healthCommand: typeof import("./health.js").healthCommand;

describe("doctor command", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../flows/doctor-health-contributions.js");
    ({ doctorCommand } = await import("./doctor.js"));
    ({ healthCommand } = await import("./health.js"));
    vi.clearAllMocks();
    providerRuntimeMocks.resolvePluginProviders.mockReturnValue([]);
  });

  it("runs legacy state migrations in yes mode without prompting", async () => {
    const { doctorCommand, runtime, runLegacyStateMigrations } =
      await arrangeLegacyStateMigrationTest();

    await (doctorCommand as (runtime: unknown, opts: Record<string, unknown>) => Promise<void>)(
      runtime,
      { yes: true },
    );

    expect(runLegacyStateMigrations).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  }, 30_000);

  it("runs legacy state migrations in non-interactive mode without prompting", async () => {
    const { doctorCommand, runtime, runLegacyStateMigrations } =
      await arrangeLegacyStateMigrationTest();

    await (doctorCommand as (runtime: unknown, opts: Record<string, unknown>) => Promise<void>)(
      runtime,
      { nonInteractive: true },
    );

    expect(runLegacyStateMigrations).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  }, 30_000);

  it("refuses doctor repair mode in Nix before repair side effects", async () => {
    const previous = process.env.OPENCLAW_NIX_MODE;
    process.env.OPENCLAW_NIX_MODE = "1";
    try {
      mockDoctorConfigSnapshot();
      await expect(doctorCommand(createDoctorRuntime(), { repair: true })).rejects.toThrow(
        "OPENCLAW_NIX_MODE=1",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_NIX_MODE;
      } else {
        process.env.OPENCLAW_NIX_MODE = previous;
      }
    }

    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("refuses doctor gateway token generation in Nix before config writes", async () => {
    const previous = process.env.OPENCLAW_NIX_MODE;
    process.env.OPENCLAW_NIX_MODE = "1";
    try {
      mockDoctorConfigSnapshot();
      await expect(
        doctorCommand(createDoctorRuntime(), { generateGatewayToken: true }),
      ).rejects.toThrow("OPENCLAW_NIX_MODE=1");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_NIX_MODE;
      } else {
        process.env.OPENCLAW_NIX_MODE = previous;
      }
    }

    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("skips gateway restarts in non-interactive mode", async () => {
    mockDoctorConfigSnapshot();

    vi.mocked(healthCommand).mockRejectedValueOnce(new Error("gateway closed"));

    serviceIsLoaded.mockResolvedValueOnce(true);
    serviceRestart.mockClear();
    confirm.mockClear();

    await doctorCommand(createDoctorRuntime(), { nonInteractive: true });

    expect(serviceRestart).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("migrates anthropic oauth config profile id when only email profile exists", async () => {
    mockDoctorConfigSnapshot({
      config: {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "oauth" },
          },
        },
      },
    });

    ensureAuthProfileStore.mockReturnValueOnce({
      version: 1,
      profiles: {
        "anthropic:me@example.com": {
          type: "oauth",
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          email: "me@example.com",
        },
      },
    });
    providerRuntimeMocks.resolvePluginProviders.mockReturnValue([
      {
        id: "anthropic",
        label: "Anthropic",
        auth: [],
        oauthProfileIdRepairs: [{ legacyProfileId: "anthropic:default" }],
      },
    ]);

    const previousConfigWriteSupport =
      process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE;
    process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE = "1";
    try {
      await doctorCommand(createDoctorRuntime(), { yes: true });
    } finally {
      if (previousConfigWriteSupport === undefined) {
        delete process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE;
      } else {
        process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE =
          previousConfigWriteSupport;
      }
    }

    const written = writeConfigFile.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((candidate) => {
        const auth = candidate.auth as { profiles?: unknown } | undefined;
        return Boolean(auth?.profiles);
      });
    if (!written) {
      throw new Error("Expected doctor to write migrated auth profiles");
    }
    const profiles = (written.auth as { profiles: Record<string, unknown> }).profiles;
    expect(profiles).toHaveProperty("anthropic:me@example.com");
    const migratedProfile = profiles["anthropic:me@example.com"] as
      | { provider?: unknown; mode?: unknown }
      | undefined;
    expect(migratedProfile?.provider).toBe("anthropic");
    expect(migratedProfile?.mode).toBe("oauth");
    expect(profiles["anthropic:default"]).toBeUndefined();
  }, 30_000);
});
