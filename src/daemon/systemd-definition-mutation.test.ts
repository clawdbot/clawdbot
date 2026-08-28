import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
} from "./service.test-helpers.js";

const assertNoSystemOwnership = vi.hoisted(() =>
  vi.fn<typeof import("./systemd-system.js").assertNoSystemSystemdOwnership>(),
);
const busctl = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execBusctlUser>());

vi.mock("./systemd-system.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-system.js")>()),
  assertNoSystemSystemdOwnership: assertNoSystemOwnership,
}));
vi.mock("./systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-exec.js")>()),
  assertSystemdAvailable: async () => {},
  execBusctlUser: busctl,
}));

import {
  readSystemdDefinitionMutationCapability,
  withSystemdDefinitionMutation,
} from "./systemd-definition-mutation.js";
import { stageSystemdService } from "./systemd-install.js";

describe.skipIf(process.platform === "win32")("systemd definition mutation ownership", () => {
  let root: string;
  let stateDir: string;
  let unitPath: string;
  let environmentPath: string;
  let env: Record<string, string>;
  const artifacts = [
    { artifact: "unit", select: () => unitPath },
    { artifact: "environment", select: () => environmentPath },
    { artifact: "backup", select: () => `${unitPath}.bak` },
  ];

  beforeEach(async () => {
    assertNoSystemOwnership.mockReset().mockResolvedValue(undefined);
    busctl.mockReset().mockImplementation(async (serviceEnv) => ({
      code: 1,
      termination: "exit",
      stdout: "",
      stderr: `Call failed: Unit ${serviceEnv.OPENCLAW_SYSTEMD_UNIT}.service not found.`,
    }));
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-definition-")));
    stateDir = path.join(root, "state");
    env = {
      HOME: path.join(root, "home"),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-owned",
    };
    unitPath = path.join(env.HOME!, ".config/systemd/user/openclaw-owned.service");
    environmentPath = path.join(stateDir, "gateway.systemd.env");
    await fs.mkdir(path.dirname(unitPath), { recursive: true });
    await fs.mkdir(stateDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  const stage = (environmentOverrides: Record<string, string> = {}) =>
    stageSystemdService({
      env,
      stdout: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      programArguments: [
        "/usr/bin/node",
        "/srv/openclaw/dist/index.js",
        "gateway",
        "--port",
        "18789",
      ],
      environment: {
        OPENCLAW_GATEWAY_PORT: "18789",
        OPENCLAW_GATEWAY_TOKEN: "replacement-secret-canary",
        ...environmentOverrides,
      },
      environmentValueSources: {
        OPENCLAW_GATEWAY_PORT: "inline",
        OPENCLAW_GATEWAY_TOKEN: "file",
      },
    });

  function managerDefinition(
    fragmentPath: string,
    dropInPaths: string[] = [],
    environmentFiles: Array<[string, boolean]> = [],
    isLoaded = async () => true,
  ) {
    busctl.mockImplementation(async (_env, args) => {
      const loaded = await isLoaded();
      return {
        code: 0,
        termination: "exit",
        stderr: "",
        stdout: args.includes("LoadUnit")
          ? JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/owned"] })
          : args.includes("org.freedesktop.systemd1.Unit")
            ? buildSystemdUnitPropertyOutput({
                fragmentPath: loaded ? fragmentPath : "",
                dropInPaths: loaded ? dropInPaths : [],
                loadState: loaded ? "loaded" : "not-found",
              })
            : buildSystemdManagerPropertyOutput({
                programArguments: ["/usr/bin/node", "gateway"],
                environment: ["TOKEN=manager-secret-canary"],
                environmentFiles,
              }),
      };
    });
  }

  it.each(["unit", "state", "ancestor"])(
    "publishes a first unit through a %s directory alias discovered by the manager",
    async (alias) => {
      const directory =
        alias === "state"
          ? stateDir
          : alias === "ancestor"
            ? path.dirname(path.dirname(unitPath))
            : path.dirname(unitPath);
      const target = path.join(root, "unit-directory");
      await fs.rename(directory, target);
      await fs.symlink(target, directory);
      managerDefinition(unitPath, [], [], () =>
        fs.access(unitPath).then(
          () => true,
          () => false,
        ),
      );
      await expect(readSystemdDefinitionMutationCapability(env)).resolves.toEqual({
        kind: "writable",
      });
      const rename = fs.rename.bind(fs);
      let published = false;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (destination === unitPath) {
          expect(await fs.readFile(environmentPath, "utf8")).toContain("replacement-secret-canary");
          published = true;
        }
        await rename(source, destination);
      });
      await expect(stage()).resolves.toMatchObject({ unitPath });
      expect(published).toBe(true);
      await expect(readSystemdDefinitionMutationCapability(env)).resolves.toEqual({
        kind: "writable",
      });
      expect(await fs.readFile(unitPath, "utf8")).toContain("ExecStart=");
      expect(await fs.readdir(path.dirname(unitPath))).toEqual([path.basename(unitPath)]);
      expect(await fs.readdir(stateDir)).toEqual([path.basename(environmentPath)]);
    },
  );

  it.each(
    ["unit", "environment"].flatMap((artifact) =>
      ["root-owned", "unsafe mode", "changed alias", "retargeted alias"].map((scenario) => ({
        artifact,
        scenario,
      })),
    ),
  )("protects an aliased $artifact directory with $scenario", async ({ artifact, scenario }) => {
    const file = artifact === "unit" ? unitPath : environmentPath;
    const directory = path.dirname(file);
    const target = path.join(root, "alias-target");
    const replacement = path.join(root, "alias-replacement");
    await fs.rename(directory, target);
    await fs.mkdir(replacement);
    await fs.symlink(target, directory);
    managerDefinition(unitPath, [], [], () =>
      fs.access(unitPath).then(
        () => true,
        () => false,
      ),
    );
    if (scenario === "root-owned") {
      const stat = fs.stat.bind(fs);
      vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
        const value = await stat(...args);
        if (args[0] === directory) {
          Object.defineProperty(value, "uid", { value: 0 });
        }
        return value;
      });
    } else if (scenario === "unsafe mode") {
      await fs.chmod(target, 0o777);
    } else {
      const writeFile = fs.writeFile.bind(fs);
      let replaced = false;
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        await writeFile(...args);
        if (
          !replaced &&
          typeof args[0] === "string" &&
          path.basename(args[0]).startsWith(`${path.basename(file)}.`) &&
          args[0].endsWith(".tmp")
        ) {
          replaced = true;
          // Replacing an alias must reject publication and clean the original directory.
          await fs.rename(directory, `${directory}.previous`);
          await fs.symlink(scenario === "retargeted alias" ? replacement : target, directory);
        }
      });
    }
    if (scenario === "retargeted alias") {
      await expect(stage()).rejects.toThrow();
    } else {
      await expect(stage()).rejects.toThrow(
        scenario === "changed alias" ? "changed during publication" : "SERVICE_DEFINITION_",
      );
    }
    expect(await fs.readdir(target)).toEqual([]);
    expect(await fs.readdir(replacement)).toEqual([]);
    expect(await fs.readdir(stateDir)).toEqual([]);
  });

  it.each(["fragment", "drop-in", "parent"])(
    "seals a root-owned manager %s before publication",
    async (kind) => {
      const extra = path.join(
        root,
        "global-user",
        kind === "fragment" ? "service.d" : "owned.service.d",
        "operator.conf",
      );
      await fs.mkdir(path.dirname(extra), { recursive: true });
      await fs.writeFile(extra, "[Service]\nEnvironment=TOKEN=operator-secret-canary\n");
      if (kind !== "fragment") {
        await fs.writeFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n");
      }
      managerDefinition(kind === "fragment" ? extra : unitPath, kind === "fragment" ? [] : [extra]);
      const originalLstat = fs.lstat.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await originalLstat(...args);
        if (args[0] === (kind === "parent" ? path.dirname(extra) : extra)) {
          Object.defineProperty(stat, "uid", { value: 0 });
        }
        return stat;
      });
      const before = await fs.readFile(extra);
      const entries = await fs.readdir(path.dirname(unitPath));
      const capability = await readSystemdDefinitionMutationCapability(env);
      expect(capability).toMatchObject({ kind: "sealed" });
      expect(JSON.stringify(capability)).not.toContain("secret-canary");
      await expect(stage()).rejects.toThrow("SERVICE_DEFINITION_SEALED");
      expect(await fs.readFile(extra)).toEqual(before);
      expect(await fs.readdir(path.dirname(unitPath))).toEqual(entries);
      expect(await fs.readdir(stateDir)).toEqual([]);
    },
  );

  it("refuses an uninspectable user manager before publication and redacts its diagnostics", async () => {
    busctl.mockRejectedValue(new Error("manager-secret-canary"));
    const capability = await readSystemdDefinitionMutationCapability(env);
    expect(capability).toMatchObject({ kind: "unknown" });
    expect(JSON.stringify(capability)).not.toContain("secret-canary");
    await expect(stage()).rejects.toThrow("SERVICE_DEFINITION_UNKNOWN");
    expect(await fs.readdir(stateDir)).toEqual([]);
    expect(await fs.readdir(path.dirname(unitPath))).toEqual([]);
  });

  it.each(["unchanged", "changed", "first install"])(
    "reads root-owned type-wide defaults without write authority (%s)",
    async (scenario) => {
      const changed = scenario === "changed";
      const firstInstall = scenario === "first install";
      const shared = path.join(root, "distribution-user", "service.d", "default.conf");
      await fs.mkdir(path.dirname(shared), { recursive: true, mode: 0o755 });
      await fs.writeFile(shared, "[Service]\nTimeoutStopSec=30s\n", { mode: 0o644 });
      if (!firstInstall) {
        await fs.writeFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n");
      }
      await fs.writeFile(environmentPath, "OPERATOR=unchanged\n");
      managerDefinition(unitPath, [shared], [], async () =>
        firstInstall
          ? fs.stat(unitPath).then(
              () => true,
              () => false,
            )
          : true,
      );
      const lstat = fs.lstat.bind(fs);
      const open = fs.open.bind(fs);
      const readFile = fs.readFile.bind(fs);
      let sharedFd: number | undefined;
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        if (args[0] === shared || args[0] === path.dirname(shared)) {
          Object.defineProperty(stat, "uid", { value: 0 });
          Object.defineProperty(stat, "gid", { value: 0 });
        }
        return stat;
      });
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        sharedFd = args[0] === shared ? handle.fd : undefined;
        if (args[0] === shared) {
          const stat = handle.stat.bind(handle);
          vi.spyOn(handle, "stat").mockImplementation(async () => {
            const opened = await stat();
            Object.defineProperty(opened, "uid", { value: 0 });
            Object.defineProperty(opened, "gid", { value: 0 });
            return opened;
          });
        }
        return handle;
      });
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (typeof args[0] === "string" && args[0].startsWith("/proc/self/fdinfo/")) {
          return `mnt_id:\t${args[0] === `/proc/self/fdinfo/${sharedFd}` ? 2 : 1}\n`;
        }
        if (args[0] === "/proc/self/mountinfo") {
          return `1 0 0:1 / / rw - tmpfs tmpfs rw\n2 1 0:2 / ${shared} ro - tmpfs tmpfs ro\n`;
        }
        return readFile(...args);
      });
      await expect(readSystemdDefinitionMutationCapability(env)).resolves.toEqual({
        kind: "writable",
      });
      if (firstInstall) {
        const rename = fs.rename.bind(fs);
        vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
          await rename(source, destination);
          if (destination === unitPath) {
            expect(await fs.readFile(environmentPath, "utf8")).toContain(
              "replacement-secret-canary",
            );
            // Native LoadUnit reveals type-wide defaults only once the base exists,
            // without daemon-reload between the not-found and loaded observations.
            expect(await fs.readFile(shared, "utf8")).toContain("30s");
          }
        });
      }
      if (changed) {
        const originalUnit = await fs.readFile(unitPath, "utf8");
        const rename = fs.rename.bind(fs);
        let edited = false;
        vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
          await rename(source, destination);
          if (destination === unitPath && !edited) {
            edited = true;
            await fs.writeFile(shared, "[Service]\nTimeoutStopSec=60s\n");
          }
        });
        await expect(stage()).rejects.toThrow("changed during publication");
        expect(await fs.readFile(unitPath, "utf8")).toBe(originalUnit);
        expect(await fs.readFile(environmentPath, "utf8")).toBe("OPERATOR=unchanged\n");
      } else {
        await stage();
        expect(await fs.readFile(unitPath, "utf8")).toContain("/srv/openclaw/dist/index.js");
        expect(await fs.readFile(environmentPath, "utf8")).toContain("replacement-secret-canary");
      }
      expect(await fs.readFile(shared, "utf8")).toContain(changed ? "60s" : "30s");
    },
  );

  it.each(["unit", "unit replacement", "environment", "backup"])(
    "preserves a concurrent %s change during first-load discovery",
    async (artifact) => {
      const shared = path.join(root, "service.d", "default.conf");
      await fs.mkdir(path.dirname(shared));
      await fs.writeFile(shared, "[Service]\nTimeoutStopSec=30s\n");
      managerDefinition(unitPath, [shared], [], () =>
        fs.stat(unitPath).then(
          () => true,
          () => false,
        ),
      );
      const edited =
        artifact === "environment"
          ? environmentPath
          : artifact === "backup"
            ? `${unitPath}.bak`
            : unitPath;
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        await rename(source, destination);
        if (destination === unitPath) {
          expect(await fs.readFile(environmentPath, "utf8")).toContain("replacement-secret-canary");
          if (artifact === "unit replacement") {
            const replacement = path.join(root, "operator-replacement");
            await fs.writeFile(replacement, "OPERATOR=concurrent\n");
            await rename(replacement, edited);
          } else {
            await fs.writeFile(edited, "OPERATOR=concurrent\n");
          }
        }
      });

      await expect(stage()).rejects.toThrow("changed during publication");

      expect(await fs.readFile(edited, "utf8")).toBe("OPERATOR=concurrent\n");
      for (const target of [unitPath, environmentPath]) {
        if (target !== edited) {
          await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      expect(await fs.readFile(shared, "utf8")).toContain("30s");
      for (const directory of [path.dirname(unitPath), stateDir]) {
        expect((await fs.readdir(directory)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
      }
    },
  );

  it.each(["existing unit", "unit-specific drop-in", "selected fragment"])(
    "rejects new manager inputs after publication for a %s",
    async (scenario) => {
      const existing = scenario === "existing unit";
      const extra = path.join(
        root,
        scenario === "unit-specific drop-in" ? "owned.service.d" : "service.d",
        "operator.conf",
      );
      await fs.mkdir(path.dirname(extra));
      await fs.writeFile(extra, "[Service]\nTimeoutStopSec=30s\n");
      if (existing) {
        await fs.writeFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n");
      }
      let published = false;
      managerDefinition(unitPath, [], [], async () => existing);
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        await rename(source, destination);
        if (destination === unitPath && !published) {
          published = true;
          managerDefinition(
            scenario === "selected fragment" ? extra : unitPath,
            scenario === "selected fragment" ? [] : [extra],
            [],
            () =>
              fs.stat(unitPath).then(
                () => true,
                () => false,
              ),
          );
        }
      });

      await expect(stage()).rejects.toThrow("changed during publication");
      expect(await fs.readFile(extra, "utf8")).toContain("30s");
      if (existing) {
        expect(await fs.readFile(unitPath, "utf8")).toBe(
          "[Service]\nExecStart=/usr/bin/node gateway\n",
        );
      } else {
        await expect(fs.stat(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(fs.stat(environmentPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["uid", "gid", "mode"] as const)(
    "rejects changed %s between lstat and open",
    async (field) => {
      await fs.writeFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n");
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (args[0] === unitPath) {
          const stat = handle.stat.bind(handle);
          vi.spyOn(handle, "stat").mockImplementation(async () => {
            const opened = await stat();
            Object.defineProperty(opened, field, {
              value: field === "mode" ? opened.mode | 0o022 : opened[field] + 1,
            });
            return opened;
          });
        }
        return handle;
      });
      await expect(readSystemdDefinitionMutationCapability(env)).resolves.toMatchObject({
        kind: "unknown",
      });
      expect(await fs.readdir(stateDir)).toEqual([]);
    },
  );

  it.each(["fragment", "drop-in"])(
    "fingerprints a safe same-owner manager %s without snapshotting or restoring it",
    async (kind) => {
      const extra = path.join(root, "operator.conf");
      await fs.writeFile(extra, "[Service]\nEnvironment=OWNER=first\n");
      await fs.writeFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n");
      await fs.writeFile(environmentPath, "OPERATOR=preserved\n");
      managerDefinition(kind === "fragment" ? extra : unitPath, kind === "fragment" ? [] : [extra]);
      await expect(readSystemdDefinitionMutationCapability(env)).resolves.toEqual({
        kind: "writable",
      });
      await withSystemdDefinitionMutation(env, env, async (mutation) => {
        expect([...mutation.snapshots.keys()]).toEqual([unitPath, environmentPath]);
        await expect(mutation.publish(extra, "must not publish", 0o600)).rejects.toThrow(
          "Not a managed service publication target",
        );
        await expect(
          mutation.restore(extra, { contents: Buffer.from("must not restore"), mode: 0o600 }),
        ).rejects.toThrow("Not a managed service publication target");
        await mutation.publish(unitPath, "managed definition", 0o644);
        await mutation.restore(extra, null);
        expect(await fs.readFile(extra, "utf8")).toContain("OWNER=first");
        const writeFile = fs.writeFile.bind(fs);
        vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
          await writeFile(...args);
          if (
            typeof args[0] === "string" &&
            args[0].startsWith(`${unitPath}.`) &&
            args[0].endsWith(".tmp")
          ) {
            await writeFile(extra, "[Service]\nEnvironment=OWNER=second\n");
          }
        });
        await expect(mutation.publish(unitPath, "must not publish", 0o644)).rejects.toThrow(
          "changed during publication",
        );
      });
      expect(await fs.readFile(unitPath, "utf8")).toBe("managed definition");
      expect(await fs.readFile(extra, "utf8")).toContain("OWNER=second");
      expect(await fs.readFile(environmentPath, "utf8")).toBe("OPERATOR=preserved\n");
      expect(
        (await fs.readdir(path.dirname(unitPath))).filter((file) => file.endsWith(".tmp")),
      ).toEqual([]);
    },
  );

  it.each(
    artifacts.flatMap(({ artifact, select }) =>
      ["between publications", "after rename", "replacement after rename"].map((change) => ({
        artifact,
        select,
        change,
      })),
    ),
  )("rejects a concurrent $artifact edit $change", async ({ select, change }) => {
    const target = select();
    await withSystemdDefinitionMutation(env, env, async (mutation) => {
      if (change === "between publications") {
        await mutation.publish(target, "first publication", 0o600);
        await fs.writeFile(target, "operator edit");
      } else {
        const rename = fs.rename.bind(fs);
        vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
          await rename(source, destination);
          if (destination === target) {
            if (change === "replacement after rename") {
              const replacement = path.join(root, "operator-replacement");
              await fs.writeFile(replacement, "operator edit", { mode: 0o600 });
              await rename(replacement, target);
            } else {
              await fs.writeFile(target, "operator edit");
            }
          }
        });
      }
      await expect(mutation.publish(target, "must not accept", 0o600)).rejects.toThrow(
        "changed during publication",
      );
    });
    expect(await fs.readFile(target, "utf8")).toBe("operator edit");
    expect(
      (await fs.readdir(path.dirname(target))).filter((file) => file.endsWith(".tmp")),
    ).toEqual([]);
  });

  it.each(
    artifacts.flatMap(({ artifact, select }) =>
      [false, true].map((existed) => ({ artifact, select, existed })),
    ),
  )(
    "rolls back $artifact after a post-rename failure (existed=$existed)",
    async ({ select, existed }) => {
      const target = select();
      const extra = path.join(root, "operator.conf");
      await fs.writeFile(extra, "[Service]\nEnvironment=OWNER=first\n");
      managerDefinition(extra);
      if (existed) {
        await fs.writeFile(target, "previous definition", { mode: 0o400 });
      }
      const rename = fs.rename.bind(fs);
      let changed = false;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        await rename(source, destination);
        if (destination === target && !changed) {
          changed = true;
          await fs.writeFile(extra, "[Service]\nEnvironment=OWNER=second\n");
        }
      });
      await expect(
        withSystemdDefinitionMutation(env, env, (mutation) =>
          mutation.publish(target, "must not remain", 0o600),
        ),
      ).rejects.toThrow("changed during publication");
      if (existed) {
        expect(await fs.readFile(target, "utf8")).toBe("previous definition");
        expect((await fs.stat(target)).mode & 0o777).toBe(0o400);
      } else {
        await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await fs.readFile(extra, "utf8")).toContain("OWNER=second");
      expect(
        (await fs.readdir(path.dirname(target))).filter((file) => file.endsWith(".tmp")),
      ).toEqual([]);
    },
  );

  it.each(
    artifacts.flatMap(({ artifact, select }) =>
      [false, true].map((environmentExisted) => ({ artifact, select, environmentExisted })),
    ),
  )(
    "stage rollback preserves a concurrent $artifact edit (env existed=$environmentExisted)",
    async ({ artifact, select, environmentExisted }) => {
      const previousUnit = "[Service]\nExecStart=/usr/bin/node /old/index.js gateway\n";
      const previousEnvironment = "OPERATOR=original\n";
      await fs.writeFile(unitPath, previousUnit);
      if (environmentExisted) {
        await fs.writeFile(environmentPath, previousEnvironment);
      }
      const edited = select();
      const rename = fs.rename.bind(fs);
      let changed = false;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        await rename(source, destination);
        if (destination === unitPath && !changed) {
          changed = true;
          expect(await fs.readFile(environmentPath, "utf8")).toContain("replacement-secret-canary");
          await fs.writeFile(edited, "OPERATOR=concurrent\n");
        }
      });

      await expect(stage()).rejects.toThrow("changed during publication");

      expect(await fs.readFile(edited, "utf8")).toBe("OPERATOR=concurrent\n");
      if (artifact !== "unit") {
        expect(await fs.readFile(unitPath, "utf8")).toBe(previousUnit);
      }
      if (artifact !== "environment") {
        if (environmentExisted) {
          expect(await fs.readFile(environmentPath, "utf8")).toBe(previousEnvironment);
        } else {
          await expect(fs.stat(environmentPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      for (const directory of [path.dirname(unitPath), stateDir]) {
        expect((await fs.readdir(directory)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
      }
    },
  );

  it.each([
    { mount: "file-ro", mode: 0o644, kind: "sealed" },
    { mount: "file-ro", mode: 0o400, kind: "sealed" },
    { mount: "file-rw", mode: 0o644, kind: "sealed" },
    { mount: "ordinary", mode: 0o400, kind: "writable" },
    { mount: "unavailable", mode: 0o644, kind: "unknown" },
  ])("inspects a mounted target before staging ($mount, $mode)", async ({ mount, mode, kind }) => {
    await fs.writeFile(unitPath, "original definition", { mode });
    const open = fs.open.bind(fs);
    const readFile = fs.readFile.bind(fs);
    let targetFd: number | undefined;
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === unitPath) {
        targetFd = handle.fd;
      }
      return handle;
    });
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith("/proc/self/fdinfo/")) {
        return `mnt_id:\t${args[0] === `/proc/self/fdinfo/${targetFd}` && mount !== "ordinary" ? 2 : 1}\n`;
      }
      if (args[0] === "/proc/self/mountinfo") {
        if (mount === "unavailable") {
          throw Object.assign(new Error("proc unavailable"), { code: "EACCES" });
        }
        const escaped = unitPath.replaceAll(" ", "\\040");
        return `1 0 0:1 / / rw - tmpfs tmpfs rw\n2 1 0:1 /unit ${escaped} ${mount === "file-ro" ? "ro" : "rw"} - tmpfs tmpfs rw\n`;
      }
      return readFile(...args);
    });

    await expect(readSystemdDefinitionMutationCapability(env)).resolves.toMatchObject({ kind });
    if (kind === "writable") {
      await stage();
      expect(await fs.readFile(unitPath, "utf8")).toContain("/srv/openclaw/dist/index.js");
      expect((await fs.stat(unitPath)).mode & 0o777).toBe(mode);
    } else {
      await expect(stage()).rejects.toThrow(`SERVICE_DEFINITION_${kind.toUpperCase()}`);
      expect(await fs.readFile(unitPath, "utf8")).toBe("original definition");
      expect(await fs.readdir(stateDir)).toEqual([]);
      expect(await fs.readdir(path.dirname(unitPath))).toEqual([path.basename(unitPath)]);
    }
  });

  it("cleans unpublished temporary files after a write failure", async () => {
    await fs.writeFile(unitPath, "previous definition");
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await writeFile(...args);
      if (
        typeof args[0] === "string" &&
        args[0].startsWith(`${unitPath}.`) &&
        args[0].endsWith(".tmp")
      ) {
        throw new Error("write failed");
      }
    });
    await expect(
      withSystemdDefinitionMutation(env, env, (mutation) =>
        mutation.publish(unitPath, "must not remain", 0o600),
      ),
    ).rejects.toThrow("write failed");
    expect(await fs.readFile(unitPath, "utf8")).toBe("previous definition");
    expect(
      (await fs.readdir(path.dirname(unitPath))).filter((file) => file.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("rejects manager definition path changes during publication", async () => {
    const first = path.join(root, "first.conf");
    const second = path.join(root, "second.conf");
    await fs.writeFile(first, "[Service]\nEnvironment=OWNER=first\n");
    await fs.writeFile(second, "[Service]\nEnvironment=OWNER=second\n");
    await fs.writeFile(unitPath, "original definition");
    managerDefinition(unitPath, [first]);

    await expect(
      withSystemdDefinitionMutation(env, env, async (mutation) => {
        const writeFile = fs.writeFile.bind(fs);
        vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
          await writeFile(...args);
          if (
            typeof args[0] === "string" &&
            args[0].startsWith(`${unitPath}.`) &&
            args[0].endsWith(".tmp")
          ) {
            managerDefinition(unitPath, [second]);
          }
        });
        await mutation.publish(unitPath, "must not publish", 0o644);
      }),
    ).rejects.toThrow("changed during publication");
    expect(await fs.readFile(unitPath, "utf8")).toBe("original definition");
  });

  it.each(["file symlink", "unsafe mode", "uninspectable", "missing", "directory"])(
    "rejects a manager definition with %s without publication",
    async (kind) => {
      const directory = path.join(root, "operator");
      const target = path.join(directory, "operator.conf");
      await fs.mkdir(directory);
      await fs.writeFile(target, "[Service]\nEnvironment=TOKEN=protected-secret-canary\n");
      let extra = target;
      if (kind === "file symlink") {
        extra = path.join(root, "linked.conf");
        await fs.symlink(target, extra);
      } else if (kind === "unsafe mode") {
        await fs.chmod(target, 0o666);
      } else if (kind === "missing") {
        extra = path.join(directory, "missing.conf");
      } else if (kind === "directory") {
        extra = stateDir;
      } else {
        const lstat = fs.lstat.bind(fs);
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          if (args[0] === extra) {
            throw Object.assign(new Error("inspection-secret-canary"), { code: "EACCES" });
          }
          return lstat(...args);
        });
      }
      managerDefinition(extra);
      const capability = await readSystemdDefinitionMutationCapability(env);
      expect(capability).toMatchObject({ kind: "unknown" });
      expect(JSON.stringify(capability)).not.toContain("secret-canary");
      await expect(stage()).rejects.toThrow("SERVICE_DEFINITION_UNKNOWN");
      expect(await fs.readFile(target, "utf8")).toContain("protected-secret-canary");
      expect(await fs.readdir(path.dirname(unitPath))).toEqual([]);
      expect(await fs.readdir(stateDir)).toEqual([]);
    },
  );

  it("accepts the ownership owner's proven absence on a fresh non-systemd install", async () => {
    await expect(readSystemdDefinitionMutationCapability(env)).resolves.toEqual({
      kind: "writable",
    });
    expect(assertNoSystemOwnership).toHaveBeenCalledWith("openclaw-owned.service", undefined);
  });

  it.each([
    { parent: "unit", select: () => path.dirname(unitPath) },
    { parent: "environment", select: () => stateDir },
  ])("seals a foreign-owned $parent parent before creating service files", async ({ select }) => {
    const protectedParent = select();
    const originalEntries = await fs.readdir(protectedParent);
    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await originalLstat(...args);
      if (args[0] === protectedParent) {
        Object.defineProperty(stat, "uid", { value: (process.geteuid?.() ?? 0) + 1 });
      }
      return stat;
    });

    await expect(readSystemdDefinitionMutationCapability(env)).resolves.toMatchObject({
      kind: "sealed",
    });
    await expect(stage()).rejects.toThrow("SERVICE_DEFINITION_SEALED");
    expect(await fs.readdir(protectedParent)).toEqual(originalEntries);
  });

  it.each(artifacts)("seals a foreign-owned $artifact before publication", async ({ select }) => {
    await fs.writeFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n");
    const protectedPath = select();
    if (protectedPath !== unitPath) {
      await fs.writeFile(protectedPath, "protected-secret-canary\n");
    }
    const original = await fs.readFile(protectedPath);
    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await originalLstat(...args);
      if (args[0] === protectedPath) {
        Object.defineProperty(stat, "uid", { value: (process.geteuid?.() ?? 0) + 1 });
        Object.defineProperty(stat, "mode", { value: Number(stat.mode) | 0o022 });
      }
      return stat;
    });

    const capability = await readSystemdDefinitionMutationCapability(env);
    expect(capability).toMatchObject({ kind: "sealed" });
    expect(JSON.stringify(capability)).not.toContain("secret-canary");
    await expect(stage()).rejects.toThrow("SERVICE_DEFINITION_SEALED");
    expect(await fs.readFile(protectedPath)).toEqual(original);
  });

  it.each([
    ...artifacts.map(({ artifact, select }) => ({ artifact, select, fresh: false })),
    { artifact: "fresh environment", select: () => environmentPath, fresh: true },
  ])("rejects a symlinked $artifact without changing its target", async ({ select, fresh }) => {
    const file = select();
    if (file !== unitPath && !fresh) {
      await fs.writeFile(unitPath, "[Service]\n");
    }
    const target = path.join(root, "operator-target");
    await fs.writeFile(target, "operator-secret-canary\n");
    await fs.symlink(target, file);

    await expect(readSystemdDefinitionMutationCapability(env)).resolves.toMatchObject({
      kind: "unknown",
      detail: `Refusing to rewrite symlinked managed systemd file: ${file}`,
    });
    await expect(stage()).rejects.toThrow(
      `SERVICE_DEFINITION_UNKNOWN: Refusing to rewrite symlinked managed systemd file: ${file}`,
    );
    expect(await fs.readlink(file)).toBe(target);
    expect(await fs.readFile(target, "utf8")).toBe("operator-secret-canary\n");
    if (fresh) {
      await expect(fs.stat(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("publishes the unit, backup, and generated environment without chmod or secret disclosure", async () => {
    const previous = "[Service]\nExecStart=/usr/bin/node /old/index.js gateway\n";
    await fs.writeFile(unitPath, previous);
    await fs.writeFile(environmentPath, "OPERATOR_SECRET=preserved-canary\n");
    const chmod = vi.spyOn(fs, "chmod");

    await stage();

    expect(await fs.readFile(`${unitPath}.bak`, "utf8")).toBe(previous);
    expect(await fs.readFile(unitPath, "utf8")).toContain("/srv/openclaw/dist/index.js");
    expect(await fs.readFile(unitPath, "utf8")).not.toContain("replacement-secret-canary");
    expect(await fs.readFile(environmentPath, "utf8")).toContain(
      "OPERATOR_SECRET=preserved-canary",
    );
    expect(chmod).not.toHaveBeenCalled();
    expect(
      (await fs.readdir(path.dirname(unitPath))).filter((file) => file.includes(".tmp")),
    ).toEqual([]);
  });

  it("publishes only the environment selected by the effective service state dir", async () => {
    const effectiveStateDir = path.join(root, "effective-state");
    const effectiveEnvironmentPath = path.join(effectiveStateDir, "gateway.systemd.env");
    await fs.mkdir(effectiveStateDir);
    await fs.writeFile(environmentPath, "CALLER_SECRET=caller-canary\n");
    await fs.writeFile(effectiveEnvironmentPath, "OPERATOR_SECRET=preserved-canary\n");

    await stage({ OPENCLAW_STATE_DIR: effectiveStateDir });

    expect(await fs.readFile(environmentPath, "utf8")).toBe("CALLER_SECRET=caller-canary\n");
    expect(await fs.readFile(effectiveEnvironmentPath, "utf8")).toContain(
      "OPERATOR_SECRET=preserved-canary",
    );
    expect(await fs.readFile(effectiveEnvironmentPath, "utf8")).toContain(
      "OPENCLAW_GATEWAY_TOKEN=replacement-secret-canary",
    );
    expect(await fs.readFile(unitPath, "utf8")).toContain(effectiveEnvironmentPath);
  });

  it("keeps a retired generated environment file readable until the unit drops it", async () => {
    await fs.writeFile(
      unitPath,
      `[Service]\nExecStart=/usr/bin/node gateway\nEnvironmentFile=${environmentPath}\n`,
    );
    await fs.writeFile(environmentPath, "OPENCLAW_GATEWAY_TOKEN=retired-secret-canary\n");
    managerDefinition(unitPath, [], [[environmentPath, false]]);

    await stageSystemdService({
      env,
      stdout: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      programArguments: ["/usr/bin/node", "/srv/openclaw/dist/index.js", "gateway"],
      environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: "file" },
    });

    expect(await fs.readFile(environmentPath, "utf8")).toBe("");
    expect(await fs.readFile(unitPath, "utf8")).not.toContain("EnvironmentFile=");
  });

  it.each(["environment", "unit", "directory alias", "retargeted unit", "retargeted environment"])(
    "serializes canonical targets across concurrent writers (%s)",
    async (shared) => {
      const retarget = shared.startsWith("retargeted");
      const file = shared.includes("environment") ? environmentPath : unitPath;
      const directory = path.dirname(file);
      const original = path.join(root, "original");
      const replacement = path.join(root, "replacement");
      const other = { ...env };
      if (retarget) {
        await fs.rename(directory, original);
        await fs.mkdir(replacement);
        await fs.symlink(original, directory);
      } else if (shared === "environment") {
        other.OPENCLAW_SYSTEMD_UNIT = "openclaw-secondary";
      } else {
        other.OPENCLAW_STATE_DIR = path.join(root, "other-state");
        await fs.mkdir(other.OPENCLAW_STATE_DIR);
        if (shared === "directory alias") {
          other.HOME = path.join(root, "home-alias");
          await fs.symlink(env.HOME!, other.HOME);
        }
      }
      const events: string[] = [];
      const { promise: barrier, resolve: release } = createDeferred();
      const { promise: firstStarted, resolve: entered } = createDeferred();
      const first = withSystemdDefinitionMutation(env, env, async (mutation) => {
        events.push("first-start");
        entered();
        await barrier;
        if (!retarget) {
          await mutation.publish(file, "first writer", 0o600);
        }
        events.push("first-finish");
      });
      await firstStarted;
      const open = fs.open.bind(fs);
      let contended = false;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        // Reading a held sidecar follows the real owner's failed exclusive acquire.
        if (typeof args[0] === "string" && args[0].endsWith(".lock")) {
          contended = true;
        }
        return handle;
      });
      const second = withSystemdDefinitionMutation(other, other, async (mutation) => {
        events.push("second-start");
        const target = shared === "directory alias" ? file.replace(env.HOME!, other.HOME!) : file;
        if (!retarget) {
          expect(mutation.snapshots.get(target)?.contents.toString()).toBe("first writer");
        }
        await mutation.publish(target, "second writer", 0o600);
      });
      try {
        await vi.waitFor(() => expect(contended).toBe(true));
        expect(events).toEqual(["first-start"]);
        if (retarget) {
          await fs.unlink(directory);
          await fs.symlink(replacement, directory);
        }
      } finally {
        release();
      }
      await first;
      if (retarget) {
        await expect(second).rejects.toThrow("lock targets changed");
        expect(events).toEqual(["first-start", "first-finish"]);
        expect(await fs.readdir(original)).toEqual([]);
        expect(await fs.readdir(replacement)).toEqual([]);
      } else {
        await second;
        expect(events).toEqual(["first-start", "first-finish", "second-start"]);
        expect(await fs.readFile(file, "utf8")).toBe("second writer");
      }
    },
  );
});
