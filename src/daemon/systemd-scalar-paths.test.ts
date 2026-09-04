import fs from "node:fs/promises";
import path from "node:path";
import { Minimatch } from "minimatch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
  type SystemdManagerSnapshotFixture,
} from "./service.test-helpers.js";
import {
  readSystemdServiceExecStart,
  resolveSystemdEnvironmentFilePath,
  resolveSystemdUnitPath,
} from "./systemd-service-files.js";
import { buildSystemdUnit, splitSystemdLogicalLines } from "./systemd-unit.js";

const execBusctlUser = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execBusctlUser>());
vi.mock("./systemd-exec.js", () => ({ execBusctlUser }));

const programArguments = ["/usr/bin/openclaw", "gateway", "run"];
const literalDirectories = [
  { name: "plain", directory: "plain", expression: "plain", alternatives: ["plain-other"] },
  { name: "spaces", directory: "state space", expression: "state space", alternatives: ["state"] },
  {
    name: "quotes",
    directory: 'state"quote',
    expression: 'state"quote',
    alternatives: ["statequote"],
  },
  { name: "percent", directory: "state%h", expression: "state%h", alternatives: ["statepercent"] },
  {
    name: "asterisk",
    directory: "state*",
    expression: "state\\*",
    alternatives: ["state-one", "state-two"],
  },
  {
    name: "question mark",
    directory: "state?",
    expression: "state\\?",
    alternatives: ["state1", "state2"],
  },
  {
    name: "brackets",
    directory: "state[ab]",
    expression: "state\\[ab\\]",
    alternatives: ["statea", "stateb"],
  },
  {
    name: "backslash",
    directory: "state\\part",
    expression: "state\\\\part",
    alternatives: ["statepart", "state/part"],
  },
];

// These are Linux unit contracts using POSIX filenames, including characters Windows cannot create.
describe.skipIf(process.platform === "win32")("systemd scalar paths", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let home: string;
  const serviceEnv = () => ({ HOME: home, OPENCLAW_SYSTEMD_UNIT: "openclaw-scalar-fixture" });
  const unitPath = () => resolveSystemdUnitPath(serviceEnv());

  beforeEach(async () => {
    home = await fs.realpath(tempDirs.make("openclaw-systemd-scalars-"));
    await fs.mkdir(path.dirname(unitPath()), { recursive: true });
    execBusctlUser.mockReset();
    execBusctlUser.mockResolvedValue({
      code: 1,
      termination: "exit",
      stdout: "",
      stderr: "Synthetic manager unavailable",
    });
  });

  async function writeUnit(content = "[Service]\nExecStart=/usr/bin/openclaw gateway run\n") {
    await fs.writeFile(unitPath(), content, "utf8");
  }

  async function writeEnvironmentFile(filename: string, content = "SELECTED=intended\n") {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content, "utf8");
  }

  function mockManager(snapshot: Omit<SystemdManagerSnapshotFixture, "programArguments">) {
    const effective = { programArguments, fragmentPath: unitPath(), ...snapshot };
    const unitProperties = buildSystemdUnitPropertyOutput(effective);
    const serviceProperties = buildSystemdManagerPropertyOutput(effective);
    execBusctlUser.mockImplementation(async (_env, args) => {
      let stdout: string;
      if (args.includes("LoadUnit")) {
        stdout = JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/fixture"] });
      } else if (args.includes("org.freedesktop.systemd1.Unit")) {
        stdout = unitProperties;
      } else if (args.includes("org.freedesktop.systemd1.Service")) {
        stdout = serviceProperties;
      } else {
        throw new Error("Unexpected native request in scalar fixture");
      }
      return { code: 0, termination: "exit", stdout, stderr: "" };
    });
  }

  function scalarValue(unit: string, directive: string): string {
    const prefix = `${directive}=`;
    const entries = splitSystemdLogicalLines(unit).filter((line) => line.startsWith(prefix));
    expect(entries).toHaveLength(1);
    // Scalar directives do not unquote words. Strip only systemd's surrounding syntax whitespace.
    return entries
      .join("")
      .slice(prefix.length)
      .replace(/^[ \t]+|[ \t]+$/g, "");
  }

  async function readExpression(source: "authored" | "manager", expression: string) {
    if (source === "authored") {
      await writeUnit(
        `[Service]\nExecStart=/usr/bin/openclaw gateway run\nEnvironmentFile=${expression.replaceAll("%", "%%")}\n`,
      );
    } else {
      await writeUnit();
      mockManager({ environmentFiles: [[expression, false]] });
    }
    return readSystemdServiceExecStart(serviceEnv(), { requireEffective: source === "manager" });
  }

  it.each(["trailing ", "trailing\t", "trailing /.", "trailing\t/.//"])(
    "rejects working-directory spelling %j before rendering a different native cwd",
    (directory) => {
      expect(() =>
        buildSystemdUnit({ programArguments, workingDirectory: `${home}/${directory}` }),
      ).toThrow("WorkingDirectory cannot end in spaces or tabs");
    },
  );

  it.each([
    { name: "plain", directory: "cwd" },
    { name: "spaces", directory: "cwd space" },
    { name: "quotes", directory: 'cwd"quote' },
    { name: "literal percent", directory: "cwd%h" },
    { name: "trailing backslash", directory: "cwd\\" },
  ])("renders and reads the complete working directory with $name", async ({ directory }) => {
    const workingDirectory = path.join(home, directory);
    await fs.mkdir(workingDirectory);
    const unit = buildSystemdUnit({
      programArguments,
      workingDirectory,
      environment: { AFTER_CWD: "retained" },
    });
    await writeUnit(unit);

    const encoded = scalarValue(unit, "WorkingDirectory");
    expect(encoded.replaceAll("%%", "")).not.toContain("%");
    const nativePath = encoded.replaceAll("%%", "%");
    expect(nativePath.startsWith(`${home}/`)).toBe(true);
    expect(path.relative(home, nativePath).split(path.sep)).not.toContain("..");
    // Accept equivalent native directory spellings (for example a trailing /.) without prescribing one.
    await expect(fs.realpath(nativePath)).resolves.toBe(workingDirectory);
    const command = await readSystemdServiceExecStart(serviceEnv());
    expect(command?.workingDirectory).toBe(workingDirectory);
    expect(command?.environment).toEqual({ AFTER_CWD: "retained" });
  });

  it.each([
    { name: "spaces", directory: "authored space", suffix: "" },
    { name: "quotes", directory: 'authored"quote', suffix: "" },
    { name: "backslash", directory: "authored\\path", suffix: "" },
    { name: "percent", directory: "authored%h", suffix: "" },
    { name: "trailing space", directory: "authored ", suffix: "/." },
    { name: "trailing backslash", directory: "authored\\", suffix: "/." },
  ])("reads an authored working-directory scalar with $name", async ({ directory, suffix }) => {
    const workingDirectory = path.join(home, directory);
    await fs.mkdir(workingDirectory);
    const expression = `${workingDirectory.replaceAll("%", "%%")}${suffix}`;
    await writeUnit(
      `[Service]\nExecStart=/usr/bin/openclaw gateway run\nWorkingDirectory=${expression}\n`,
    );

    const command = await readSystemdServiceExecStart(serviceEnv());
    expect(command?.workingDirectory).toBe(workingDirectory);
  });

  it.each(["argv", "inline environment"] as const)(
    "keeps builder percent input literal in %s while retaining word quoting",
    async (surface) => {
      const literal = path.join(home, 'source %h literal%% "quoted"');
      const argv =
        surface === "argv"
          ? [path.join(literal, "openclaw"), "gateway", "--label", "two words"]
          : programArguments;
      const environment = surface === "inline environment" ? { OPENCLAW_STATE_DIR: literal } : {};
      await writeUnit(buildSystemdUnit({ programArguments: argv, environment }));

      const command = await readSystemdServiceExecStart(serviceEnv());
      expect(command?.programArguments).toEqual(argv);
      if (surface === "inline environment") {
        expect(command?.environment).toEqual(environment);
      }
    },
  );

  it.each(literalDirectories)(
    "generates a literal EnvironmentFile with $name without selecting neighboring files",
    async ({ directory, alternatives }) => {
      const environmentFile = resolveSystemdEnvironmentFilePath({
        stateDir: path.join(home, directory),
      });
      await writeEnvironmentFile(environmentFile);
      const neighboringFiles = alternatives.map((alternative) =>
        resolveSystemdEnvironmentFilePath({ stateDir: path.join(home, alternative) }),
      );
      for (const neighbor of neighboringFiles) {
        await writeEnvironmentFile(neighbor, "FOREIGN=must-not-be-selected\n");
      }
      const unit = buildSystemdUnit({ programArguments, environmentFiles: [environmentFile] });
      await writeUnit(unit);

      const command = await readSystemdServiceExecStart(serviceEnv());
      expect(command?.environment).toEqual({ SELECTED: "intended" });
      expect(command?.environmentValueSources).toEqual({ SELECTED: "file" });
      const encoded = scalarValue(unit, "EnvironmentFile");
      expect(encoded.startsWith("-/")).toBe(true);
      expect(encoded.replaceAll("%%", "")).not.toContain("%");
      // Independently check native-compatible literal selection, allowing either glob escape spelling.
      const matcher = new Minimatch(encoded.slice(1).replaceAll("%%", "%"), {
        nobrace: true,
        noext: true,
        platform: "linux",
        optimizationLevel: 0,
      });
      expect(matcher.match(environmentFile)).toBe(true);
      for (const neighbor of neighboringFiles) {
        expect(matcher.match(neighbor)).toBe(false);
      }
    },
  );

  describe.each(["authored", "manager"] as const)("%s EnvironmentFile expressions", (source) => {
    it.each(literalDirectories)(
      "reads a whole literal path with $name, not a tempting alternate",
      async ({ directory, expression, alternatives }) => {
        const filename = path.join(home, directory, "gateway.systemd.env");
        await writeEnvironmentFile(filename);
        for (const alternative of alternatives) {
          await writeEnvironmentFile(
            path.join(home, alternative, "gateway.systemd.env"),
            "FOREIGN=must-not-be-selected\n",
          );
        }
        const command = await readExpression(
          source,
          path.join(home, expression, "gateway.systemd.env"),
        );
        expect(command?.environment).toEqual({ SELECTED: "intended" });
        expect(command?.environmentValueSources).toEqual({ SELECTED: "file" });
      },
    );

    it("reads singleton [a-a] as the file a rather than the literal expression", async () => {
      await writeEnvironmentFile(path.join(home, "a.env"));
      await writeEnvironmentFile(path.join(home, "[a-a].env"), "FOREIGN=literal-expression-trap\n");
      const command = await readExpression(source, path.join(home, "[a-a].env"));
      expect(command?.environment).toEqual({ SELECTED: "intended" });
    });

    it.each([false, true])(
      "does not broaden a missing literal file (optional=%s)",
      async (optional) => {
        await writeEnvironmentFile(
          path.join(home, "missing-one", "gateway.systemd.env"),
          "FOREIGN=must-not-be-selected\n",
        );
        const expression = path.join(home, "missing\\*", "gateway.systemd.env");
        const declaration =
          source === "authored" ? `EnvironmentFile=${optional ? "-" : ""}${expression}\n` : "";
        await writeUnit(
          `[Service]\nExecStart=/usr/bin/openclaw gateway run\nEnvironment=INLINE=retained\n${declaration}`,
        );
        if (source === "manager") {
          mockManager({
            environment: ["INLINE=retained"],
            environmentFiles: [[expression, optional]],
          });
        }
        const command = readSystemdServiceExecStart(serviceEnv(), {
          requireEffective: source === "manager",
        });
        if (source === "manager" && !optional) {
          await expect(command).rejects.toThrow();
        } else {
          expect((await command)?.environment).toEqual({ INLINE: "retained" });
        }
      },
    );
  });

  it.each(["*.env", "[12]*.env"])(
    "preserves authored wildcard %s and declaration precedence",
    async (pattern) => {
      const environmentDir = path.join(home, "env.d");
      await writeEnvironmentFile(
        path.join(environmentDir, "20-override.env"),
        "SHARED=second\nSECOND=retained\n",
      );
      await writeEnvironmentFile(
        path.join(environmentDir, "10-base.env"),
        "SHARED=first\nFIRST=retained\n",
      );
      await writeEnvironmentFile(
        path.join(environmentDir, "outside.txt"),
        "FOREIGN=must-not-be-selected\n",
      );
      await writeUnit(
        `[Service]\nExecStart=/usr/bin/openclaw gateway run\nEnvironment=SHARED=inline\nEnvironmentFile=${path.join(environmentDir, pattern)}\n`,
      );

      const command = await readSystemdServiceExecStart(serviceEnv());
      expect(command?.environment).toEqual({
        SHARED: "second",
        FIRST: "retained",
        SECOND: "retained",
      });
      expect(command?.environmentValueSources).toEqual({
        SHARED: "inline-and-file",
        FIRST: "file",
        SECOND: "file",
      });
    },
  );

  it.each([false, true])(
    "does not read an authored relative EnvironmentFile (optional=%s)",
    async (optional) => {
      const relativeFile = path.join(path.dirname(unitPath()), "operator.env");
      await writeEnvironmentFile(relativeFile, "FOREIGN=must-not-be-read\n");
      const unit = `[Service]\nExecStart=/usr/bin/openclaw gateway run\nEnvironment=INLINE=retained\nEnvironmentFile=${optional ? "-" : ""}./operator.env\n`;
      await writeUnit(unit);
      const readFile = vi.spyOn(fs, "readFile");
      try {
        const command = await readSystemdServiceExecStart(serviceEnv());
        expect(readFile).not.toHaveBeenCalledWith(relativeFile, "utf8");
        expect(command?.environment).toEqual({ INLINE: "retained" });
        await expect(fs.readFile(unitPath(), "utf8")).resolves.toBe(unit);
      } finally {
        readFile.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "rejects a relative manager EnvironmentFile tuple (optional=%s)",
    async (optional) => {
      const relativeFile = path.join(path.dirname(unitPath()), "operator.env");
      await writeEnvironmentFile(relativeFile, "FOREIGN=must-not-be-read\n");
      const unit = "[Service]\nExecStart=/usr/bin/openclaw gateway run\n";
      await writeUnit(unit);
      mockManager({ environmentFiles: [["operator.env", optional]] });
      const readFile = vi.spyOn(fs, "readFile");
      try {
        await expect(
          readSystemdServiceExecStart(serviceEnv(), { requireEffective: true }),
        ).rejects.toThrow();
        expect(readFile).not.toHaveBeenCalledWith(relativeFile, "utf8");
        await expect(fs.readFile(unitPath(), "utf8")).resolves.toBe(unit);
      } finally {
        readFile.mockRestore();
      }
    },
  );

  it("records only the keys supplied by an authored space-containing EnvironmentFile drop-in", async () => {
    const environmentFile = path.join(home, "operator space", "operator.env");
    await writeEnvironmentFile(environmentFile);
    const dropIn = path.join(`${unitPath()}.d`, "10-operator.conf");
    await fs.mkdir(path.dirname(dropIn), { recursive: true });
    await fs.writeFile(dropIn, `[Service]\nEnvironmentFile=${environmentFile}\n`, "utf8");
    await writeUnit();
    mockManager({ environmentFiles: [[environmentFile, false]], dropInPaths: [dropIn] });

    const command = await readSystemdServiceExecStart(serviceEnv(), { requireEffective: true });
    expect(command?.environment).toEqual({ SELECTED: "intended" });
    expect(command?.managedOverrides).toEqual({ environment: { keys: ["SELECTED"] } });
  });
});
