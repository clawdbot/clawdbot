import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  getMockCallOutput,
  spyRuntimeErrors,
  spyRuntimeJson,
  spyRuntimeLogs,
} from "../test-runtime-capture.js";
import type { DaemonStatus } from "./status.gather.js";

type StatusPrinter = typeof import("./status.print.js").printDaemonStatus;
const SYNTHETIC_TOKEN = "synthetic-status-install-hint-token";
const LOG_FILENAME = "status-install-hints.log";

const surfaces = [
  {
    kind: "missing-unit",
    name: "missing service unit",
    fact: "Service unit not found",
    command: "openclaw gateway install",
  },
  {
    kind: "config-mismatch",
    name: "CLI/service config-path mismatch",
    fact: "CLI and service are using different config paths",
    command: "openclaw gateway install --force",
  },
  {
    kind: "cached-label",
    name: "cached LaunchAgent label with missing plist",
    fact: "LaunchAgent label cached but plist missing",
    command: "openclaw gateway install",
  },
  {
    kind: "config-audit",
    name: "embedded-token service audit",
    fact: "embeds OPENCLAW_GATEWAY_TOKEN",
    command: "openclaw gateway install --force",
  },
] as const;
type StatusSurface = (typeof surfaces)[number]["kind"];

type InvocationEnvironment = (accountHome: string) => NodeJS.ProcessEnv;
const deniedInvocations = [
  {
    name: "Nix-managed installation",
    environment: () => ({ OPENCLAW_NIX_MODE: "1" }),
    reason: /Nix mode detected/,
    recovery: /service install is disabled/,
  },
  {
    name: "global external supervision",
    environment: () => ({ OPENCLAW_SUPERVISOR_MODE: " EXTERNAL " }),
    reason: /managed by an external supervisor/,
    recovery: /Use that supervisor to/,
  },
  {
    name: "relocated invoking HOME",
    environment: (accountHome: string) => ({ HOME: path.join(accountHome, "relocated") }),
    reason: /non-default state dir or config path/,
    recovery: /HOME set to the OS account home/,
  },
] satisfies Array<{
  name: string;
  environment: InvocationEnvironment;
  reason: RegExp;
  recovery: RegExp;
}>;

async function withStatusFixture(
  overrides: InvocationEnvironment,
  run: (accountHome: string, print: StatusPrinter) => Promise<void>,
): Promise<void> {
  await withTestDir({ prefix: "openclaw-status-install-hints-" }, async (accountHome) => {
    // The OS account stays fixed when the invocation changes HOME; following HOME
    // here would make a relocated installation falsely look canonical.
    vi.spyOn(os, "homedir").mockReturnValue(accountHome);
    vi.spyOn(os, "userInfo").mockImplementation(() => ({
      uid: 1000,
      gid: 1000,
      username: "status-fixture",
      homedir: accountHome,
      shell: "/bin/sh",
    }));
    const stateDir = path.join(accountHome, ".openclaw");
    await withEnvAsync(
      {
        HOME: accountHome,
        USERPROFILE: accountHome,
        HOMEDRIVE: undefined,
        HOMEPATH: undefined,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_NIX_MODE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
        OPENCLAW_LAUNCHD_LABEL: undefined,
        OPENCLAW_SYSTEMD_UNIT: undefined,
        OPENCLAW_WINDOWS_TASK_NAME: undefined,
        OPENCLAW_CONTAINER: undefined,
        OPENCLAW_CONTAINER_HINT: undefined,
        OPENCLAW_LOG_PREFIX: undefined,
        ...overrides(accountHome),
      },
      async () => {
        // Import under the private home, keeping the real printer, hints, and
        // policy owners together without invoking status gathering or a manager.
        const { printDaemonStatus } = await import("./status.print.js");
        await run(accountHome, printDaemonStatus);
      },
    );
  });
}

async function createStatus(surface: StatusSurface, accountHome: string): Promise<DaemonStatus> {
  const status: DaemonStatus = {
    service: {
      label: "LaunchAgent",
      loaded: true,
      loadState: { status: "loaded" },
      loadedText: "loaded",
      notLoadedText: "not loaded",
      runtime: { status: "running", pid: 4242 },
    },
    logFile: path.join(accountHome, LOG_FILENAME),
    extraServices: [],
  };
  if (surface === "missing-unit") {
    status.service.loaded = false;
    status.service.loadState = { status: "not-loaded" };
    status.service.runtime = { status: "stopped", missingUnit: true };
  } else if (surface === "config-mismatch") {
    const serviceStateDir = path.join(accountHome, "service-state");
    const serviceConfigPath = path.join(serviceStateDir, "openclaw.json");
    status.config = {
      cli: {
        path: path.join(accountHome, ".openclaw", "openclaw.json"),
        exists: true,
        valid: true,
      },
      daemon: { path: serviceConfigPath, exists: true, valid: true },
      mismatch: true,
    };
    status.service.command = {
      programArguments: ["openclaw", "gateway"],
      environment: {
        HOME: accountHome,
        OPENCLAW_STATE_DIR: serviceStateDir,
        OPENCLAW_CONFIG_PATH: serviceConfigPath,
      },
    };
  } else if (surface === "cached-label") {
    status.service.runtime = { status: "running", pid: 4242, cachedLabel: true };
  } else {
    const { auditGatewayServiceConfig } = await import("../../daemon/service-audit.js");
    const command = {
      programArguments: ["openclaw", "gateway"],
      environment: { OPENCLAW_GATEWAY_TOKEN: SYNTHETIC_TOKEN },
    };
    status.service.command = command;
    // The embedded-token finding is platform-independent. Windows avoids native
    // unit/plist inspection and PATH/runtime probes for this non-runtime binary.
    status.service.configAudit = await auditGatewayServiceConfig({
      platform: "win32",
      command,
      env: { HOME: accountHome },
    });
  }
  return status;
}

function humanOutput(): string {
  return stripVTControlCharacters(
    [
      getMockCallOutput(vi.mocked(defaultRuntime.log)),
      getMockCallOutput(vi.mocked(defaultRuntime.error)),
    ].join("\n"),
  );
}

function expectProblemAndLogs(output: string, fact: string): void {
  expect(output).toContain(fact);
  expect(output).toContain("File logs:");
  expect(output).toContain(LOG_FILENAME);
  expect(output).not.toContain(SYNTHETIC_TOKEN);
}

beforeEach(() => {
  // Cached-label fixtures model launchd, regardless of the test runner's host.
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  spyRuntimeLogs(defaultRuntime);
  spyRuntimeErrors(defaultRuntime);
  spyRuntimeJson(defaultRuntime);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(deniedInvocations)(
  "status recovery under $name",
  ({ environment, reason, recovery }) => {
    it.each(surfaces)(
      "retains $name facts without unusable native advice",
      async ({ kind, fact }) => {
        await withStatusFixture(environment, async (accountHome, print) => {
          const status = await createStatus(kind, accountHome);
          print(status, { json: false });

          const output = humanOutput();
          expectProblemAndLogs(output, fact);
          expect(output).toMatch(reason);
          expect(output).toMatch(recovery);
          expect(output).not.toMatch(/\bgateway\s+install\b/);
          expect(output).not.toMatch(/\bdoctor\s+--repair\b/);
          expect(output).not.toContain("launchctl bootout");
          expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
        });
      },
    );
  },
);

describe("eligible status recovery", () => {
  it.each(surfaces)(
    "keeps the canonical default installation's $name advice",
    async ({ kind, fact, command }) => {
      await withStatusFixture(
        () => ({}),
        async (accountHome, print) => {
          const status = await createStatus(kind, accountHome);
          print(status, { json: false });

          const output = humanOutput();
          expectProblemAndLogs(output, fact);
          expect(output).toContain(command);
          if (kind === "cached-label") {
            expect(output).toContain("launchctl bootout gui/$UID/ai.openclaw.gateway");
          }
        },
      );
    },
  );

  it("keeps a canonical named profile's matching native identity and install command", async () => {
    await withStatusFixture(
      (accountHome) => ({
        OPENCLAW_PROFILE: "work",
        OPENCLAW_STATE_DIR: path.join(accountHome, ".openclaw-work"),
        OPENCLAW_CONFIG_PATH: path.join(accountHome, ".openclaw-work", "openclaw.json"),
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.work",
      }),
      async (accountHome, print) => {
        print(await createStatus("missing-unit", accountHome), { json: false });
        expect(humanOutput()).toContain("openclaw --profile work gateway install");
        expect(humanOutput()).not.toContain("service management skipped");
      },
    );
  });

  it("does not treat Doctor-only external policy as denied explicit service installation", async () => {
    await withStatusFixture(
      () => ({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }),
      async (accountHome, print) => {
        print(await createStatus("config-audit", accountHome), { json: false });
        const output = humanOutput();
        expect(output).toContain("openclaw gateway install --force");
        expect(output).not.toContain("managed by an external supervisor");
      },
    );
  });

  it("does not treat a diagnostic-only service as denied cleanup and reinstallation", async () => {
    await withStatusFixture(
      () => ({}),
      async (accountHome, print) => {
        const status = await createStatus("cached-label", accountHome);
        status.service.targetRole = "diagnostic-only";
        print(status, { json: false });

        const output = humanOutput();
        expect(output).toContain("launchctl bootout gui/$UID/ai.openclaw.gateway");
        expect(output).toContain("openclaw gateway install");
      },
    );
  });
});

it("reports the Nix gate before global external supervision", async () => {
  await withStatusFixture(
    () => ({ OPENCLAW_NIX_MODE: "1", OPENCLAW_SUPERVISOR_MODE: "external" }),
    async (accountHome, print) => {
      print(await createStatus("missing-unit", accountHome), { json: false });
      const output = humanOutput();
      expect(output).toContain("Nix mode detected");
      expect(output).not.toContain("managed by an external supervisor");
      expect(output).not.toMatch(/\bgateway\s+install\b/);
    },
  );
});

it("preserves the JSON audit projection after human recovery rendering", async () => {
  await withStatusFixture(
    () => ({ OPENCLAW_NIX_MODE: "1" }),
    async (accountHome, print) => {
      const status = await createStatus("config-audit", accountHome);
      const original = structuredClone(status);
      print(status, { json: false });
      expect(status).toEqual(original);
      vi.mocked(defaultRuntime.log).mockClear();
      vi.mocked(defaultRuntime.error).mockClear();

      print(status, { json: true });
      expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
        ...original,
        service: {
          ...original.service,
          command: { programArguments: ["openclaw", "gateway"], environment: undefined },
        },
      });
      expect(defaultRuntime.log).not.toHaveBeenCalled();
      expect(defaultRuntime.error).not.toHaveBeenCalled();
    },
  );
});

it("keeps stopped-runtime diagnostics without manufacturing an install refusal", async () => {
  await withStatusFixture(
    () => ({ OPENCLAW_NIX_MODE: "1" }),
    async (accountHome, print) => {
      const status = await createStatus("cached-label", accountHome);
      status.service.runtime = { status: "stopped" };
      print(status, { json: false });

      const output = humanOutput();
      expectProblemAndLogs(output, "Service is loaded but not running");
      expect(output).toContain("Runtime: stopped");
      expect(output).not.toContain("Nix mode detected");
      expect(output).not.toMatch(/\bgateway\s+install\b/);
    },
  );
});
