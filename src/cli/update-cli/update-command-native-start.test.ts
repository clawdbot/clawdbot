import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as launchctl from "../../daemon/launchd-exec.js";
import { startLaunchAgent } from "../../daemon/launchd-lifecycle.js";
import { bootstrapLaunchAgentOrThrow } from "../../daemon/launchd-runtime.js";
import * as launchdSystem from "../../daemon/launchd-system.js";
import {
  resumeScheduledTaskAutoStartAfterUpdate,
  startScheduledTask,
} from "../../daemon/schtasks-control.js";
import * as schtasksExec from "../../daemon/schtasks-exec.js";
import * as taskLayout from "../../daemon/schtasks-layout.js";
import * as taskRuntime from "../../daemon/schtasks-runtime.js";
import * as systemdExec from "../../daemon/systemd-exec.js";
import { startSystemdService } from "../../daemon/systemd-lifecycle.js";
import * as systemdScope from "../../daemon/systemd-scope.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";

const nativeSpawn = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("unexpected native spawn");
  }),
);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: nativeSpawn,
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let control: string;
const success = { stdout: "", stderr: "", code: 0, termination: "exit" as const };
beforeEach(() => {
  nativeSpawn.mockClear();
  root = fs.realpathSync(dirs.make("native-start-fence-"));
  control = path.join(root, "control");
  fs.mkdirSync(control, { mode: 0o700 });
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
});
afterEach(() => vi.restoreAllMocks());
function revoke() {
  const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
  try {
    db.prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?").run(
      "replaced",
      root,
    );
  } finally {
    db.close();
  }
}
function owned(operation: (fence: UpdateRecoveryFence) => Promise<void>) {
  return withUpdateCommandExecutor(randomUUID(), async (executor) =>
    operation(await executor.enter(root)),
  );
}
function serviceArgs(fence: UpdateRecoveryFence) {
  return {
    stdout: new PassThrough(),
    env: { HOME: root },
    assertCurrent: () => fence.assertCurrent(),
  };
}

it.each(["user", "system"] as const)(
  "refuses systemd %s start after scope inspection revokes its real executor",
  async (scope) => {
    vi.spyOn(systemdScope, "findInstalledSystemdGatewayScope").mockImplementation(async () => {
      await Promise.resolve();
      revoke();
      return {
        scope,
        unitName: "openclaw-gateway.service",
        unitPath: path.join(root, "gateway.service"),
      };
    });
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    vi.spyOn(systemdExec, "assertSystemdAvailable").mockResolvedValue();
    vi.spyOn(systemdScope, "assertNoSystemGatewayOwnership").mockResolvedValue();
    const native = vi.spyOn(systemdExec, "execSystemctl").mockResolvedValue(success);
    const user = vi.spyOn(systemdExec, "execSystemctlUser").mockResolvedValue(success);
    await expect(owned(async (fence) => startSystemdService(serviceArgs(fence)))).rejects.toThrow(
      /executor|ownership/i,
    );
    expect(native).not.toHaveBeenCalled();
    expect(user).not.toHaveBeenCalled();
  },
);

it("refuses systemd start after reset-failed revokes its real executor", async () => {
  vi.spyOn(systemdScope, "findInstalledSystemdGatewayScope").mockResolvedValue({
    scope: "user",
    unitName: "openclaw-gateway.service",
    unitPath: path.join(root, "gateway.service"),
  });
  vi.spyOn(systemdExec, "assertSystemdAvailable").mockResolvedValue();
  vi.spyOn(systemdScope, "assertNoSystemGatewayOwnership").mockResolvedValue();
  const calls: string[] = [];
  vi.spyOn(systemdExec, "execSystemctlUser").mockImplementation(async (_env, args) => {
    calls.push(args[0]!);
    if (args[0] === "reset-failed") {
      await Promise.resolve();
      revoke();
    }
    return success;
  });
  await expect(owned(async (fence) => startSystemdService(serviceArgs(fence)))).rejects.toThrow(
    /executor|ownership/i,
  );
  expect(calls).toEqual(["reset-failed"]);
});

it.each(["inspection", "enable", "not-loaded"])(
  "refuses launchd start after %s revokes its real executor",
  async (at) => {
    vi.spyOn(launchdSystem, "assertNoSystemLaunchDaemonOwnership").mockImplementation(async () => {
      await Promise.resolve();
      if (at === "inspection") {
        revoke();
      }
    });
    const calls: string[] = [];
    vi.spyOn(launchctl, "execLaunchctl").mockImplementation(async (args) => {
      calls.push(args[0]!);
      await Promise.resolve();
      if (at === "enable" && args[0] === "enable") {
        revoke();
      }
      if (at === "not-loaded" && args[0] === "kickstart") {
        revoke();
        return { ...success, code: 1, stderr: "Could not find service" };
      }
      return success;
    });
    await expect(owned(async (fence) => startLaunchAgent(serviceArgs(fence)))).rejects.toThrow(
      /executor|ownership/i,
    );
    expect(calls).toEqual(
      at === "inspection" ? [] : at === "enable" ? ["enable"] : ["enable", "kickstart"],
    );
  },
);

it("refuses bootstrap after enable revokes the real executor", async () => {
  const calls: string[] = [];
  vi.spyOn(launchctl, "execLaunchctl").mockImplementation(async (args) => {
    calls.push(args[0]!);
    await Promise.resolve();
    revoke();
    return success;
  });
  await expect(
    owned(async (fence) => {
      const args = {
        domain: "gui/501",
        serviceTarget: "gui/501/test",
        plistPath: path.join(root, "gateway.plist"),
        actionHint: "test",
        assertCurrent: () => fence.assertCurrent(),
      };
      await bootstrapLaunchAgentOrThrow(args);
    }),
  ).rejects.toThrow(/executor|ownership/i);
  expect(calls).toEqual(["enable"]);
});

it("preserves separately restored launchd enable policy across bootstrap", async () => {
  vi.spyOn(launchdSystem, "assertNoSystemLaunchDaemonOwnership").mockResolvedValue();
  const calls: string[] = [];
  vi.spyOn(launchctl, "execLaunchctl").mockImplementation(async (args) => {
    calls.push(args[0]!);
    return args[0] === "kickstart" && calls.length === 1
      ? { ...success, code: 1, stderr: "Could not find service" }
      : success;
  });
  await owned(async (fence) => {
    const args = { ...serviceArgs(fence), preserveAutoStart: true };
    await startLaunchAgent(args);
  });
  expect(calls).toEqual(["kickstart", "bootstrap", "kickstart"]);
});

it("refuses task start after registration inspection revokes its real executor", async () => {
  vi.spyOn(taskRuntime, "assertSchtasksAvailable").mockResolvedValue();
  vi.spyOn(taskRuntime, "isRegisteredScheduledTask").mockImplementation(async () => {
    await Promise.resolve();
    revoke();
    return true;
  });
  vi.spyOn(taskRuntime, "readScheduledTaskRuntime").mockResolvedValue({ status: "running" });
  const native = vi.spyOn(schtasksExec, "execSchtasks").mockResolvedValue(success);
  await expect(owned(async (fence) => startScheduledTask(serviceArgs(fence)))).rejects.toThrow(
    /executor|ownership/i,
  );
  expect(native).not.toHaveBeenCalled();
});

it("refuses task enable after preparation revokes its real executor", async () => {
  const native = vi.spyOn(schtasksExec, "execSchtasks").mockResolvedValue(success);
  await expect(
    owned(async (fence) => {
      const options = {
        beforeMutation: async () => {
          await Promise.resolve();
          revoke();
        },
        assertCurrent: () => fence.assertCurrent(),
      };
      await resumeScheduledTaskAutoStartAfterUpdate({ HOME: root }, options);
    }),
  ).rejects.toThrow(/executor|ownership/i);
  expect(native).not.toHaveBeenCalled();
});

it("refuses login-item spawn when command inspection revokes the real executor", async () => {
  vi.spyOn(taskLayout, "readScheduledTaskCommand").mockImplementation(async () => {
    await Promise.resolve();
    revoke();
    return { programArguments: [process.execPath, "gateway-test.js"] };
  });

  await expect(
    owned(async (fence) =>
      taskRuntime.startStartupEntry({ HOME: root }, new PassThrough(), undefined, () =>
        fence.assertCurrent(),
      ),
    ),
  ).rejects.toThrow(/executor|ownership/i);
  expect(nativeSpawn).not.toHaveBeenCalled();
});
it("refuses login-item fallback for the captured registered task", async () => {
  vi.spyOn(taskRuntime, "assertSchtasksAvailable").mockResolvedValue();
  vi.spyOn(taskRuntime, "isRegisteredScheduledTask").mockResolvedValue(false);
  vi.spyOn(taskRuntime, "isStartupEntryInstalled").mockResolvedValue(true);
  const start = vi.spyOn(taskRuntime, "startStartupEntry").mockResolvedValue();
  const native = vi.spyOn(schtasksExec, "execSchtasks").mockResolvedValue(success);
  await expect(
    owned(async (fence) => startScheduledTask({ ...serviceArgs(fence), preserveAutoStart: true })),
  ).rejects.toThrow("Captured Scheduled Task registration");
  expect(start).not.toHaveBeenCalled();
  expect(native).not.toHaveBeenCalled();
});
