import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import {
  confirmDoctorServiceRepair,
  shouldManageGatewayService,
} from "./doctor-service-repair-policy.js";

const mocks = vi.hoisted(() => ({
  hasInstalledDefinition: vi.fn(async () => true),
  isContainerEnvironment: vi.fn(() => false),
  isLoaded: vi.fn(async () => false),
  resolveGatewayService: vi.fn(),
}));

vi.mock("../infra/container-environment.js", () => ({
  isContainerEnvironment: mocks.isContainerEnvironment,
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: mocks.resolveGatewayService,
}));

describe("doctor gateway service repair policy", () => {
  beforeEach(() => {
    mocks.hasInstalledDefinition.mockReset().mockResolvedValue(true);
    mocks.isContainerEnvironment.mockReset().mockReturnValue(false);
    mocks.isLoaded.mockReset().mockResolvedValue(false);
    mocks.resolveGatewayService.mockReset().mockReturnValue({
      hasInstalledDefinition: mocks.hasInstalledDefinition,
      isLoaded: mocks.isLoaded,
    });
    mockProcessPlatform("linux");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { name: "native host", env: {}, expected: true, probes: "none" },
    {
      name: "Doctor-only external repair policy on a native host",
      env: { OPENCLAW_SERVICE_REPAIR_POLICY: "external" },
      expected: true,
      probes: "none",
    },
    {
      name: "globally external supervision",
      env: { OPENCLAW_SUPERVISOR_MODE: "external" },
      container: true,
      expected: false,
      probes: "none",
    },
    {
      name: "Kubernetes orchestration",
      env: { KUBERNETES_SERVICE_HOST: "10.96.0.1", KUBERNETES_SERVICE_PORT: "443" },
      container: true,
      expected: false,
      probes: "none",
    },
    {
      name: "Docker without an installed OpenClaw service",
      env: {},
      container: true,
      installed: false,
      expected: false,
      probes: "definition",
    },
    {
      name: "Docker without installed-definition capability",
      env: {},
      container: true,
      missingCapability: true,
      expected: false,
      probes: "missing-capability",
    },
    {
      name: "Docker with an installed but unloaded service and reachable manager",
      env: {},
      container: true,
      expected: true,
      probes: "manager",
    },
    {
      name: "Docker with an installed service and unavailable manager",
      env: {},
      container: true,
      unavailableManager: true,
      expected: false,
      probes: "manager",
    },
    {
      name: "Docker with a failed installed-definition probe",
      env: {},
      container: true,
      failedDefinition: true,
      expected: false,
      probes: "definition",
    },
    {
      name: "non-Linux container",
      env: {},
      container: true,
      platform: "darwin" as const,
      expected: false,
      probes: "none",
    },
  ])("applies native service ownership in $name", async (scenario) => {
    mocks.isContainerEnvironment.mockReturnValue(scenario.container === true);
    if (scenario.platform) {
      mockProcessPlatform(scenario.platform);
    }
    if (scenario.installed === false) {
      mocks.hasInstalledDefinition.mockResolvedValue(false);
    }
    if (scenario.failedDefinition) {
      mocks.hasInstalledDefinition.mockRejectedValue(new Error("service discovery failed"));
    }
    if (scenario.missingCapability) {
      mocks.resolveGatewayService.mockReturnValue({ isLoaded: mocks.isLoaded });
    }
    if (scenario.unavailableManager) {
      mocks.isLoaded.mockRejectedValue(new Error("systemd user manager unavailable"));
    }

    await expect(shouldManageGatewayService(scenario.env)).resolves.toBe(scenario.expected);

    if (scenario.probes === "none") {
      expect(mocks.resolveGatewayService).not.toHaveBeenCalled();
      expect(mocks.hasInstalledDefinition).not.toHaveBeenCalled();
    } else if (scenario.probes !== "missing-capability") {
      expect(mocks.hasInstalledDefinition).toHaveBeenCalledWith({
        env: scenario.env,
        timeoutMs: 5_000,
      });
    }
    if (scenario.probes === "manager") {
      expect(mocks.isLoaded).toHaveBeenCalledWith({ env: scenario.env, timeoutMs: 5_000 });
    } else {
      expect(mocks.isLoaded).not.toHaveBeenCalled();
    }
  });

  it.each(["OPENCLAW_SERVICE_REPAIR_POLICY", "OPENCLAW_SUPERVISOR_MODE"])(
    "never confirms a Doctor repair when %s is external",
    async (envKey) => {
      const prompter = createDoctorPrompter({
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: { repair: true },
      });
      const confirm = vi.spyOn(prompter, "confirmRuntimeRepair");

      await withEnvAsync({ [envKey]: "external" }, async () => {
        await expect(
          confirmDoctorServiceRepair(prompter, { message: "Repair gateway service?" }),
        ).resolves.toBe(false);
      });

      expect(confirm).not.toHaveBeenCalled();
    },
  );
});
