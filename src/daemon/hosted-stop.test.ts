import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { prepareHostedStopExecutor } from "./hosted-stop-executor.js";
import { prepareHostedGatewayStop, type GatewayProcessOwner } from "./hosted-stop.js";
import { probeLaunchAgentState } from "./launchd-runtime.js";
import { execSystemctl } from "./systemd-exec.js";

vi.mock("node:fs/promises", () => ({ default: { readFile: vi.fn() } }));
vi.mock("../shared/pid-alive.js", () => ({ getFileLockProcessStartTime: vi.fn() }));
vi.mock("./systemd-exec.js", () => ({ execSystemctl: vi.fn() }));
vi.mock("./hosted-stop-executor.js", () => ({ prepareHostedStopExecutor: vi.fn() }));
vi.mock("./launchd-runtime.js", () => ({
  probeLaunchAgentState: vi.fn(),
  resolveLaunchAgentGuiDomain: () => "gui/501",
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let cgroup = "/system.slice/openclaw-test.service";
const executorPid = 4321;
const execute = vi.fn<Awaited<ReturnType<typeof prepareHostedStopExecutor>>["execute"]>();
const dispose = vi.fn<() => Promise<void>>();
const processOwner: GatewayProcessOwner = { ownsProcessLifecycle: true, supervisor: "systemd" };
const commandResult = (stdout: string) => ({
  code: 0,
  termination: "exit" as const,
  stdout,
  stderr: "",
});
const systemdFields = () => ({
  Id: "openclaw-test.service",
  LoadState: "loaded",
  ActiveState: "active",
  SubState: "running",
  MainPID: String(process.pid),
  ControlGroup: cgroup,
  InvocationID: "a".repeat(32),
  ExecMainStartTimestampMonotonic: "100",
  Job: "",
  CanStop: "yes",
  RefuseManualStop: "no",
});
const renderFields = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

beforeEach(() => {
  vi.resetAllMocks();
  dispose.mockResolvedValue(undefined);
  processOwner.supervisor = "systemd";
  cgroup = "/system.slice/openclaw-test.service";
  vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", undefined);
  vi.stubEnv("OPENCLAW_LAUNCHD_LABEL", "ai.openclaw.test");
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  vi.mocked(getFileLockProcessStartTime).mockReturnValue(10);
  vi.mocked(execSystemctl).mockImplementation(async () =>
    commandResult(renderFields(systemdFields())),
  );
  vi.mocked(fs.readFile).mockImplementation(async () => `0::${cgroup}\n`);
  vi.mocked(prepareHostedStopExecutor).mockImplementation(async (params) => {
    const scope = params.scopeArgs?.find((arg) => arg.startsWith("--unit="))?.slice(7);
    vi.mocked(fs.readFile).mockImplementation(async (file) =>
      file === `/proc/${executorPid}/cgroup`
        ? `0::${cgroup.slice(0, cgroup.lastIndexOf("/"))}/${scope}\n`
        : `0::${cgroup}\n`,
    );
    await params.verifyPlacement?.(executorPid);
    return { execute, dispose };
  });
  execute.mockImplementation(async (assertCurrent) => {
    assertCurrent();
    return { disposition: "accepted", detail: "" };
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
});

describe("hosted native stop", () => {
  it.each([
    { platformName: "linux", supervisor: null },
    { platformName: "darwin", supervisor: null },
    { platformName: "win32", supervisor: null },
    { platformName: "win32", supervisor: "schtasks" },
  ] as const)(
    "exits only the owned process on $platformName with supervisor $supervisor",
    async ({ platformName, supervisor }) => {
      Object.defineProperty(process, "platform", { ...platform, value: platformName });
      const abort = new AbortController();
      const stop = await prepareHostedGatewayStop(
        { ownsProcessLifecycle: true, supervisor },
        () => {},
        abort.signal,
      );
      await expect(stop.execute(() => {})).resolves.toEqual({ outcome: "exit" });
      await expect(
        stop.execute(() => {
          throw new Error("retired host");
        }),
      ).rejects.toThrow("retired host");
      abort.abort();
      await expect(stop.execute(() => {})).rejects.toThrow();
      await stop.dispose();
      expect(getFileLockProcessStartTime).not.toHaveBeenCalled();
      expect(fs.readFile).not.toHaveBeenCalled();
      expect(probeLaunchAgentState).not.toHaveBeenCalled();
      expect(execSystemctl).not.toHaveBeenCalled();
      expect(prepareHostedStopExecutor).not.toHaveBeenCalled();
    },
  );

  it.skipIf(typeof process.getuid !== "function")(
    "keeps a user service on its exact user manager",
    async () => {
      cgroup = `/user.slice/user-${process.getuid!()}.slice/user@${process.getuid!()}.service/app.slice/openclaw-test.service`;
      const stop = await prepareHostedGatewayStop(
        processOwner,
        () => {},
        new AbortController().signal,
      );
      expect(prepareHostedStopExecutor).toHaveBeenCalledWith(
        expect.objectContaining({
          scopeArgs: expect.arrayContaining(["--user", "--scope"]),
          command: expect.arrayContaining(["--user"]),
        }),
      );
      await expect(stop.execute(() => {})).resolves.toEqual({ outcome: "accepted" });
      expect(execSystemctl).toHaveBeenCalled();
      expect(vi.mocked(execSystemctl).mock.calls.every(([args]) => args[0] === "--user")).toBe(
        true,
      );
      await stop.dispose();
    },
  );

  it.each([
    ["CanStop", "no"],
    ["RefuseManualStop", "yes"],
  ])("rejects %s=%s before acceptance and reports a late refusal", async (field, value) => {
    vi.mocked(execSystemctl).mockResolvedValue(
      commandResult(renderFields({ ...systemdFields(), [field]: value })),
    );
    await expect(
      prepareHostedGatewayStop(processOwner, () => {}, new AbortController().signal),
    ).rejects.toThrow("does not permit manual stop");
    expect(prepareHostedStopExecutor).not.toHaveBeenCalled();
    vi.mocked(execSystemctl).mockResolvedValue(commandResult(renderFields(systemdFields())));
    const stop = await prepareHostedGatewayStop(
      processOwner,
      () => {},
      new AbortController().signal,
    );
    vi.mocked(execSystemctl).mockResolvedValue(
      commandResult(renderFields({ ...systemdFields(), [field]: value })),
    );
    await expect(stop.execute(() => {})).resolves.toMatchObject({ outcome: "refused" });
    expect(execute).not.toHaveBeenCalled();
    await stop.dispose();
  });
  it("prepares an independent control scope and acknowledges native acceptance only at execution", async () => {
    const stop = await prepareHostedGatewayStop(
      processOwner,
      () => {},
      new AbortController().signal,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(prepareHostedStopExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        command: [
          "systemctl",
          "--system",
          "--no-ask-password",
          "--no-block",
          "stop",
          "openclaw-test.service",
        ],
        scopeArgs: expect.arrayContaining(["--system", "--scope"]),
      }),
    );
    await expect(stop.execute(() => {})).resolves.toEqual({ outcome: "accepted" });
    expect(execSystemctl).toHaveBeenCalled();
    expect(vi.mocked(execSystemctl).mock.calls.every(([args]) => args[0] === "--system")).toBe(
      true,
    );
    await stop.dispose();
  });

  it.each([
    ["Id", "other.service"],
    ["MainPID", "999999"],
    ["InvocationID", "b".repeat(32)],
    ["ExecMainStartTimestampMonotonic", "101"],
    ["Job", "23"],
    ["ControlGroup", "/system.slice/other.service"],
  ])("rejects changed %s during preparation before accepting stop", async (field, value) => {
    vi.mocked(execSystemctl)
      .mockResolvedValueOnce(commandResult(renderFields(systemdFields())))
      .mockResolvedValue(commandResult(renderFields({ ...systemdFields(), [field]: value })));
    await expect(
      prepareHostedGatewayStop(processOwner, () => {}, new AbortController().signal),
    ).rejects.toThrow(/systemd|instance/);
    expect(execute).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(["cgroup", "unit"])(
    "rejects caller revocation during awaited %s discovery",
    async (discovery) => {
      const assertCaller = vi.fn();
      const revoke = () => {
        assertCaller.mockImplementation(() => {
          throw new Error("closed caller");
        });
      };
      if (discovery === "cgroup") {
        vi.mocked(fs.readFile).mockImplementationOnce(async () => {
          revoke();
          return `0::${cgroup}\n`;
        });
      } else {
        vi.mocked(execSystemctl).mockImplementationOnce(async () => {
          revoke();
          return commandResult(renderFields(systemdFields()));
        });
      }
      await expect(
        prepareHostedGatewayStop(processOwner, assertCaller, new AbortController().signal),
      ).rejects.toThrow("closed caller");
      expect(prepareHostedStopExecutor).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("disposes a prepared executor when its caller is revoked across the await", async () => {
    const assertCaller = vi.fn();
    vi.mocked(prepareHostedStopExecutor).mockImplementationOnce(async () => {
      assertCaller.mockImplementation(() => {
        throw new Error("closed caller");
      });
      return { execute, dispose };
    });
    await expect(
      prepareHostedGatewayStop(processOwner, assertCaller, new AbortController().signal),
    ).rejects.toThrow("closed caller");
    expect(execute).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(["refused", "uncertain"] as const)(
    "classifies a %s result without manufacturing completion",
    async (disposition) => {
      const stop = await prepareHostedGatewayStop(
        processOwner,
        () => {},
        new AbortController().signal,
      );
      execute.mockResolvedValueOnce({ disposition, detail: "native fault" });
      await expect(stop.execute(() => {})).resolves.toMatchObject({
        outcome: disposition,
        detail: expect.stringContaining("native fault"),
      });
      // Reopening requires a fresh native identity query after an explicit refusal.
      expect(execSystemctl).toHaveBeenCalledTimes(disposition === "refused" ? 4 : 3);
      await stop.dispose();
    },
  );

  it.each([
    ["InvocationID", "b".repeat(32)],
    ["ExecMainStartTimestampMonotonic", "101"],
  ])("does not execute against a replaced %s at the terminal boundary", async (field, value) => {
    const stop = await prepareHostedGatewayStop(
      processOwner,
      () => {},
      new AbortController().signal,
    );
    vi.mocked(execSystemctl).mockResolvedValue(
      commandResult(renderFields({ ...systemdFields(), [field]: value })),
    );
    await expect(stop.execute(() => {})).resolves.toMatchObject({ outcome: "uncertain" });
    expect(execute).not.toHaveBeenCalled();
    await stop.dispose();
  });

  it("does not execute when the terminal owner is revoked during the native identity query", async () => {
    const stop = await prepareHostedGatewayStop(
      processOwner,
      () => {},
      new AbortController().signal,
    );
    const assertCurrent = vi.fn();
    vi.mocked(execSystemctl).mockImplementationOnce(async () => {
      assertCurrent.mockImplementation(() => {
        throw new Error("retired host");
      });
      return commandResult(renderFields(systemdFields()));
    });
    await expect(stop.execute(assertCurrent)).resolves.toEqual({
      outcome: "uncertain",
      detail: "retired host",
    });
    expect(execute).not.toHaveBeenCalled();
    await stop.dispose();
  });

  it("uses canonical macOS job status for ordinary bootout without persistent mutation", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    processOwner.supervisor = "launchd";
    vi.mocked(probeLaunchAgentState).mockResolvedValue({
      state: "running",
      // Native launchctl prints nested coalition state after the running job's state.
      runtime: { pid: process.pid, state: "active" },
    });
    const stop = await prepareHostedGatewayStop(
      processOwner,
      () => {},
      new AbortController().signal,
    );
    expect(prepareHostedStopExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        command: ["/bin/launchctl", "bootout", "gui/501/ai.openclaw.test"],
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    await expect(stop.execute(() => {})).resolves.toEqual({ outcome: "accepted" });
    await stop.dispose();
  });

  it("rejects an unrelated launchd PID before preparing an executor", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    processOwner.supervisor = "launchd";
    vi.mocked(probeLaunchAgentState).mockResolvedValue({
      state: "running",
      runtime: { pid: 999999, state: "running" },
    });
    await expect(
      prepareHostedGatewayStop(processOwner, () => {}, new AbortController().signal),
    ).rejects.toThrow("exact Gateway");
    expect(prepareHostedStopExecutor).not.toHaveBeenCalled();
  });

  it.each(["external", "unowned Windows process"])(
    "rejects an unsupported %s owner while still serving",
    async (owner) => {
      if (owner === "external") {
        processOwner.supervisor = "external";
      } else {
        Object.defineProperty(process, "platform", { ...platform, value: "win32" });
        processOwner.supervisor = "schtasks";
      }
      await expect(
        prepareHostedGatewayStop(
          { ...processOwner, ownsProcessLifecycle: owner === "external" },
          () => {},
          new AbortController().signal,
        ),
      ).rejects.toThrow(/external supervisor|does not own the process lifecycle/);
      expect(prepareHostedStopExecutor).not.toHaveBeenCalled();
    },
  );
});
