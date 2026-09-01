import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The verifier owns containment and loader policy; inventory only observes types.
export function auditMacWorkerPortability(runtime, node) {
  const inside = (candidate) => candidate === runtime || candidate.startsWith(`${runtime}/`);
  const systemLibrary = (candidate) => {
    // A system-looking prefix must not hide a load path that escapes with ../.
    const normalized = path.normalize(candidate);
    return normalized.startsWith("/usr/lib/") || normalized.startsWith("/System/Library/");
  };
  function expandLoaderPath(value, filename) {
    return value
      .replace(/^@loader_path(?=\/|$)/u, path.dirname(filename))
      .replace(/^@executable_path(?=\/|$)/u, path.dirname(node));
  }
  function loadSlices(filename) {
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    const fd = fs.openSync(filename, flags);
    let output;
    let sliceCount;
    try {
      const header = Buffer.alloc(8);
      if (
        !fs.fstatSync(fd).isFile() ||
        fs.readSync(fd, header, 0, header.length, 0) !== header.length
      ) {
        throw new Error(`Unreadable native header in ${filename}`);
      }
      const magic = header.readUInt32BE(0);
      sliceCount = magic === 0xcafebabe || magic === 0xcafebabf ? header.readUInt32BE(4) : 1;
      // Stable descriptor labels keep filenames out of the tool's record framing.
      // Explicit all-slice selection is required even when a host slice exists.
      output = execFileSync("/usr/bin/otool", ["-arch", "all", "-h", "-l", "/dev/fd/3"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", fd],
      });
    } finally {
      fs.closeSync(fd);
    }
    const sections = output.split(/^\/dev\/fd\/3(?: \(architecture .+\))?:\n/mu);
    if (sections.shift() !== "" || sections.length !== sliceCount) {
      throw new Error(`Incomplete native architecture output in ${filename}`);
    }
    return sections.map((section) => {
      const blocks = section.split(/Load command \d+\n/u);
      const preamble = blocks.shift();
      if (!preamble) {
        throw new Error(`Missing native architecture header in ${filename}`);
      }
      const [heading, columnsLine, valuesLine, ...extra] = preamble.trim().split("\n");
      const columns = columnsLine?.trim().split(/\s+/u) ?? [];
      const values = valuesLine?.trim().split(/\s+/u) ?? [];
      if (heading !== "Mach header" || extra.length || columns.length !== values.length) {
        throw new Error(`Unreadable native architecture header in ${filename}`);
      }
      const headerValue = (name) => {
        const value = values[columns.indexOf(name)];
        if (value === undefined || !Number.isInteger(Number(value))) {
          throw new Error(`Unreadable native ${name} in ${filename}`);
        }
        return value;
      };
      const architecture = ["cputype", "cpusubtype", "caps"].map(headerValue).join(":");
      if (blocks.length !== Number(headerValue("ncmds"))) {
        throw new Error(`Incomplete native load commands in ${filename}`);
      }
      const commands = blocks.flatMap((block) => {
        const command = /^\s*cmd (LC_\w+)$/mu.exec(block)?.[1];
        // LC_ID_DYLIB is an install ID, not a file the loader will open.
        if (!command || !/^LC_(?:LOAD.*DYLIB|REEXPORT_DYLIB|RPATH)$/u.test(command)) {
          return [];
        }
        const value = /^\s*(?:name|path) (.+) \(offset \d+\)$/mu.exec(block)?.[1];
        if (!value) {
          throw new Error(`Unreadable native load command in ${filename}`);
        }
        return [{ command, value }];
      });
      return { architecture, commands };
    });
  }

  const output = execFileSync(
    "/usr/bin/python3",
    [fileURLToPath(new URL("./mac-native-inventory.py", import.meta.url)), runtime],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const records = output.split("\0");
  if (records.pop() !== "" || records.length % 2 !== 0) {
    throw new Error("Incomplete worker native inventory");
  }
  const native = [];
  for (let index = 0; index < records.length; index += 2) {
    const kind = records[index];
    const filename = records[index + 1];
    if (!filename || !inside(filename)) {
      throw new Error("Invalid worker inventory path");
    }
    if (kind === "symlink") {
      if (!inside(fs.realpathSync(filename))) {
        throw new Error(`Worker symlink escapes bundle: ${filename}`);
      }
    } else if (kind === "executable" || kind === "library") {
      native.push(filename);
    } else {
      throw new Error(`Invalid worker inventory kind: ${kind}`);
    }
  }
  const resolvedNode = fs.realpathSync(node);
  if (!inside(resolvedNode)) {
    throw new Error("Worker executable escapes bundle");
  }
  const nodeSlices = loadSlices(resolvedNode);
  const nodeRpaths = new Map(
    nodeSlices.map(({ architecture, commands }) => [
      architecture,
      commands.filter(({ command }) => command === "LC_RPATH"),
    ]),
  );
  for (const filename of native) {
    const slices = filename === resolvedNode ? nodeSlices : loadSlices(filename);
    for (const { architecture, commands } of slices) {
      // A working slice must not supply missing loader paths to another slice.
      const rpaths = [
        ...(nodeRpaths.get(architecture) ?? []),
        ...commands.filter(({ command }) => command === "LC_RPATH"),
      ];
      for (const { command, value } of commands) {
        const candidates = value.startsWith("@rpath/")
          ? rpaths.map(({ value: prefix }) =>
              path.join(expandLoaderPath(prefix, filename), value.slice(7)),
            )
          : [expandLoaderPath(value, filename)];
        if (
          !candidates.some(
            (candidate) =>
              systemLibrary(candidate) ||
              (path.isAbsolute(candidate) &&
                inside(path.resolve(candidate)) &&
                fs.existsSync(candidate) &&
                inside(fs.realpathSync(candidate))),
          )
        ) {
          throw new Error(`Nonportable ${command} in ${filename} (${architecture}): ${value}`);
        }
      }
    }
  }
  return native.length;
}
