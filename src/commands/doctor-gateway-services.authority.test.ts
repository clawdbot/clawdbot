import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import * as gatewayService from "../daemon/service.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
} from "../daemon/service.test-helpers.js";
import { buildSystemdUnit } from "../daemon/systemd-unit.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const edges = vi.hoisted(() => ({
  command: vi.fn<typeof import("../process/exec.js").runCommandWithTimeout>(),
  runtimeProbe: vi.fn<typeof import("../process/exec.js").runExec>(),
  note: vi.fn<(message: string, title?: string) => void>(),
}));

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: edges.command,
  runExec: edges.runtimeProbe,
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: edges.note }));

import { maybeRepairGatewayServiceConfig } from "./doctor-gateway-services.js";

const refusals = [
  { scenario: "sealed", kind: "sealed", reason: "sealed-mount", guidance: "deployment owner" },
  {
    scenario: "unsafe",
    kind: "unknown",
    reason: "unsafe-permissions",
    guidance: "chmod go-w",
  },
  {
    scenario: "uninspectable",
    kind: "unknown",
    reason: "inspection-failed",
    guidance: "native service-manager availability",
  },
] as const;
type Scenario = (typeof refusals)[number]["scenario"] | "writable" | "rejected";

// All tokens are synthetic. Assertions report equality booleans, never token bytes.
const embeddedToken = "doctor-fixture-embedded-token";
const existingToken = "doctor-fixture-config-token";
const inspectionCanary = "doctor-fixture-private-inspection-detail";

describe.skipIf(process.platform === "win32")("Doctor native repair authority ordering", () => {
  let state: OpenClawTestState | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    await state?.cleanup();
    state = undefined;
  });

  async function runRepair(
    scenario: Scenario,
    {
      tokenPresent = false,
      update = false,
      blockedTarget,
    }: { tokenPresent?: boolean; update?: boolean; blockedTarget?: "installed" | "planned" } = {},
  ) {
    state = await createOpenClawTestState({ prefix: "doctor-authority-" });
    const { root, home, stateDir, configPath } = state;
    await fs.chmod(stateDir, 0o700);
    const installedStateDir = blockedTarget ? path.join(root, "installed-state") : stateDir;
    const unitPath = path.join(home, ".config/systemd/user/openclaw-gateway.service");
    const environmentPath = path.join(stateDir, "gateway.systemd.env");
    const installedEnvironmentPath = path.join(installedStateDir, "gateway.systemd.env");
    const wrapperPath = path.join(root, "openclaw-fixture");
    const systemUnits = path.join(root, "system-units");
    await fs.mkdir(installedStateDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
    await fs.mkdir(systemUnits, { mode: 0o755 });
    await fs.writeFile(wrapperPath, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    const cfg: OpenClawConfig = {
      gateway: {
        mode: "local",
        auth: { mode: "token", ...(tokenPresent ? { token: existingToken } : {}) },
      },
      plugins: { enabled: false },
    };
    const originalConfig = `${JSON.stringify(cfg, null, 2)}\n`;
    const programArguments = [wrapperPath, "gateway", "--port", "18789"];
    const environment = {
      HOME: home,
      OPENCLAW_STATE_DIR: installedStateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WRAPPER: wrapperPath,
      OPENCLAW_GATEWAY_TOKEN: embeddedToken,
      PATH: "/usr/local/bin:/usr/bin:/bin",
    };
    const originalUnit = buildSystemdUnit({ programArguments, environment });
    const originalEnvironment = "OPERATOR_FIXTURE=unchanged\n";
    await fs.writeFile(configPath, originalConfig, { mode: 0o600 });
    await fs.writeFile(unitPath, originalUnit, { mode: 0o644 });
    await fs.writeFile(environmentPath, originalEnvironment, { mode: 0o600 });
    if (blockedTarget) {
      await fs.writeFile(installedEnvironmentPath, originalEnvironment, { mode: 0o600 });
    }

    // Model one synthetic OS account; the real install-identity guard still runs.
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.spyOn(os, "userInfo").mockReturnValue({
      homedir: home,
      username: "doctor-fixture",
      uid: process.geteuid!(),
      gid: process.getegid!(),
      shell: "/bin/sh",
    });
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith("/proc/self/fdinfo/")) {
        return "mnt_id:\t1\n";
      }
      if (args[0] === "/proc/self/mountinfo") {
        return `1 0 0:1 / / ${scenario === "sealed" ? "ro" : "rw"} - tmpfs tmpfs rw\n`;
      }
      return readFile(...args);
    });
    if (scenario === "unsafe") {
      const unsafePath = blockedTarget
        ? blockedTarget === "installed"
          ? installedEnvironmentPath
          : environmentPath
        : unitPath;
      await fs.chmod(unsafePath, 0o666);
    } else if (scenario === "uninspectable") {
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (args[0] === unitPath) {
          throw Object.assign(new Error(inspectionCanary), { code: "EACCES" });
        }
        return lstat(...args);
      });
    }

    const events: string[] = [];
    const nativeActions: string[] = [];
    const unexpectedProcesses: string[] = [];
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (destination === configPath) {
        events.push("config-published");
      } else if (
        [unitPath, `${unitPath}.bak`, environmentPath, installedEnvironmentPath].includes(
          String(destination),
        )
      ) {
        events.push("service-published");
      }
    });
    edges.runtimeProbe.mockImplementation(async (_file, args) => {
      if (args[0] !== "-e" || !args[1]?.includes("sqliteVersion")) {
        unexpectedProcesses.push("unexpected runtime process");
        throw new Error("Unexpected fixture runtime process");
      }
      return {
        stdout: JSON.stringify({ nodeVersion: "24.16.0", sqliteVersion: "3.51.3" }),
        stderr: "",
      };
    });
    edges.command.mockImplementation(async (argv) => {
      const [binary, ...args] = argv;
      let stdout: string;
      let code = 0;
      if (binary === "busctl") {
        stdout = args.includes("LoadUnit")
          ? JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/fixture"] })
          : args.includes("org.freedesktop.systemd1.Unit")
            ? buildSystemdUnitPropertyOutput({ fragmentPath: unitPath })
            : buildSystemdManagerPropertyOutput({
                programArguments,
                environment: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
              });
      } else if (binary === "systemctl" && args.includes("--property=LoadState")) {
        stdout = "not-found\n";
      } else if (binary === "systemctl" && args.includes("--property=UnitPath")) {
        stdout = `${systemUnits}\n`;
      } else if (binary === "systemctl" && args.includes("show")) {
        stdout =
          "After=network-online.target\nWants=network-online.target\nRestartUSec=5s\nKillMode=control-group\n";
      } else if (binary === "systemctl" && args.includes("status")) {
        stdout = "running\n";
      } else if (binary === "systemctl" && args.includes("is-active")) {
        stdout = "inactive\n";
        code = 3;
      } else if (
        binary === "systemctl" &&
        args.some((arg) => ["daemon-reload", "enable", "restart"].includes(arg))
      ) {
        nativeActions.push(
          args.find((arg) => ["daemon-reload", "enable", "restart"].includes(arg))!,
        );
        stdout = "";
      } else {
        unexpectedProcesses.push(argv.join(" "));
        throw new Error("Unexpected fixture process");
      }
      return { stdout, stderr: "", code, signal: null, killed: false, termination: "exit" };
    });
    const errors: string[] = [];
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: (...args) => {
        const message = args.map(String).join(" ");
        errors.push(message);
        if (message.includes("SERVICE_DEFINITION_")) {
          events.push("repair-refused");
        }
      },
      exit: vi.fn(),
    };
    const prompter: DoctorPrompter = {
      confirm: async () => true,
      confirmAutoFix: async () => true,
      confirmAggressiveAutoFix: async () => true,
      confirmRuntimeRepair: async () => true,
      select: async (_params, fallback) => fallback,
      shouldRepair: true,
      shouldForce: update,
      repairMode: {
        shouldRepair: true,
        shouldForce: update,
        canPrompt: !update,
        nonInteractive: update,
        updateInProgress: update,
      },
    };
    return withEnvAsync(
      {
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_SYSTEMD_UNIT: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
        OPENCLAW_NIX_MODE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_PORT: undefined,
        OPENCLAW_WRAPPER: wrapperPath,
        OPENCLAW_UPDATE_IN_PROGRESS: update ? "1" : undefined,
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: update ? "1" : undefined,
      },
      async () => {
        expect(isDefaultInstallIdentity()).toBe(true);
        const service = gatewayService.resolveGatewayService();
        const capability = await service.readDefinitionMutationCapability!({
          env: process.env,
          environment,
        });
        const plannedCapability = blockedTarget
          ? await service.readDefinitionMutationCapability!({
              env: process.env,
              environment: { ...environment, OPENCLAW_STATE_DIR: stateDir },
            })
          : undefined;
        if (scenario === "rejected") {
          // Native filesystem failures return a capability; also exercise an adapter rejection.
          vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue({
            ...service,
            readDefinitionMutationCapability: async () => {
              throw new Error(inspectionCanary);
            },
          });
        }
        const result = await maybeRepairGatewayServiceConfig(cfg, "local", runtime, prompter);
        const configBytes = await fs.readFile(configPath, "utf8");
        const persisted: OpenClawConfig = JSON.parse(configBytes);
        const diagnostics = [...edges.note.mock.calls.map(([message]) => message), ...errors].join(
          "\n",
        );
        const observations = {
          capability,
          plannedCapability,
          events,
          configBytesPreserved: configBytes === originalConfig,
          configTokenPreserved: persisted.gateway?.auth?.token === cfg.gateway?.auth?.token,
          embeddedTokenPersisted: persisted.gateway?.auth?.token === embeddedToken,
          returnedTokenPreserved: result.gateway?.auth?.token === cfg.gateway?.auth?.token,
          returnedConfigPreserved: isDeepStrictEqual(result, JSON.parse(originalConfig)),
          unitBytesPreserved: (await fs.readFile(unitPath, "utf8")) === originalUnit,
          environmentBytesPreserved:
            (await fs.readFile(environmentPath, "utf8")) === originalEnvironment,
          installedEnvironmentBytesPreserved:
            (await fs.readFile(installedEnvironmentPath, "utf8")) === originalEnvironment,
          unitDirectoryEntries: await fs.readdir(path.dirname(unitPath)),
          nativeActions,
        };
        expect(unexpectedProcesses).toEqual([]);
        expect(diagnostics.includes(embeddedToken)).toBe(false);
        expect(diagnostics.includes(existingToken)).toBe(false);
        expect(diagnostics.includes(inspectionCanary)).toBe(false);
        return { observations, diagnostics, errors };
      },
    );
  }

  it.each(
    refusals.flatMap(({ scenario, kind, reason, guidance }) =>
      [false, true].map((tokenPresent) => ({ scenario, kind, reason, guidance, tokenPresent })),
    ),
  )(
    "preserves config and service when $scenario repair is refused (existing token=$tokenPresent)",
    async ({ scenario, kind, reason, guidance, tokenPresent }) => {
      const { observations, diagnostics } = await runRepair(scenario, { tokenPresent });
      expect(observations.capability).toMatchObject({ kind, reason });
      expect(diagnostics).toContain(`SERVICE_DEFINITION_${kind.toUpperCase()}: [${reason}]`);
      expect(diagnostics).toContain(guidance);
      expect(observations.unitBytesPreserved).toBe(true);
      expect(observations.environmentBytesPreserved).toBe(true);
      expect(observations.installedEnvironmentBytesPreserved).toBe(true);
      expect(observations.unitDirectoryEntries).toEqual(["openclaw-gateway.service"]);
      expect(observations.nativeActions).toEqual([]);
      expect(observations.events).not.toContain("service-published");
      expect
        .soft(observations.configTokenPreserved, "refused repair must preserve the config token")
        .toBe(true);
      expect
        .soft(observations.configBytesPreserved, "refused repair must preserve config bytes")
        .toBe(true);
      expect
        .soft(observations.returnedTokenPreserved, "refused repair must return the original token")
        .toBe(true);
      expect(observations.returnedConfigPreserved).toBe(true);
    },
  );

  it.each(refusals)(
    "preserves config and service when $scenario update staging is refused",
    async ({ scenario, kind, reason }) => {
      const { observations, diagnostics } = await runRepair(scenario, { update: true });
      expect(observations.capability).toMatchObject({ kind, reason });
      expect(diagnostics).toContain(`SERVICE_DEFINITION_${kind.toUpperCase()}: [${reason}]`);
      expect(observations.configBytesPreserved).toBe(true);
      expect(observations.configTokenPreserved).toBe(true);
      expect(observations.returnedConfigPreserved).toBe(true);
      expect(observations.unitBytesPreserved).toBe(true);
      expect(observations.environmentBytesPreserved).toBe(true);
      expect(observations.unitDirectoryEntries).toEqual(["openclaw-gateway.service"]);
      expect(observations.events).not.toContain("service-published");
      expect(observations.nativeActions).toEqual([]);
    },
  );

  it.each(["installed", "planned"] as const)(
    "preserves both generated environments when only the %s target is protected",
    async (blockedTarget) => {
      const { observations, diagnostics } = await runRepair("unsafe", { blockedTarget });
      const denied = { kind: "unknown", reason: "unsafe-permissions" };
      expect(observations.capability).toMatchObject(
        blockedTarget === "installed" ? denied : { kind: "writable" },
      );
      expect(observations.plannedCapability).toMatchObject(
        blockedTarget === "planned" ? denied : { kind: "writable" },
      );
      expect(diagnostics).toContain("SERVICE_DEFINITION_UNKNOWN: [unsafe-permissions]");
      expect(diagnostics).toContain("chmod go-w");
      expect(observations).toMatchObject({
        configBytesPreserved: true,
        configTokenPreserved: true,
        returnedConfigPreserved: true,
        unitBytesPreserved: true,
        environmentBytesPreserved: true,
        installedEnvironmentBytesPreserved: true,
        unitDirectoryEntries: ["openclaw-gateway.service"],
        nativeActions: [],
      });
      expect(observations.events).not.toContain("service-published");
    },
  );

  it("redacts a rejected capability inspection and leaves the repair untouched", async () => {
    const { observations, diagnostics } = await runRepair("rejected");
    expect(diagnostics).toContain("SERVICE_DEFINITION_UNKNOWN: [inspection-failed]");
    expect(diagnostics).toContain("native service-manager availability");
    expect(observations).toMatchObject({
      configBytesPreserved: true,
      configTokenPreserved: true,
      returnedConfigPreserved: true,
      unitBytesPreserved: true,
      environmentBytesPreserved: true,
      installedEnvironmentBytesPreserved: true,
      unitDirectoryEntries: ["openclaw-gateway.service"],
      nativeActions: [],
    });
    expect(observations.events).not.toContain("service-published");
  });

  it("preserves authentication while publishing an authorized service repair", async () => {
    const { observations, errors } = await runRepair("writable");
    expect(observations.capability).toEqual({ kind: "writable" });
    expect(errors).toEqual([]);
    expect(observations.embeddedTokenPersisted).toBe(true);
    expect(observations.unitBytesPreserved).toBe(false);
    expect(observations.events.indexOf("config-published")).toBeLessThan(
      observations.events.indexOf("service-published"),
    );
    expect(observations.nativeActions).toEqual(["daemon-reload", "enable", "restart"]);
    expect(observations.unitDirectoryEntries).toEqual([
      "openclaw-gateway.service",
      "openclaw-gateway.service.bak",
    ]);
  });
});
