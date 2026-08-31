// The direct survivor lane supports generated user units, not arbitrary systemd configuration.
// Inspection and launch share this parser so reported argv/environment cannot drift from execution.
import fs from "node:fs";
import path from "node:path";

const unitName = "openclaw-gateway.service";
const unitPath = path.join(process.env.HOME, ".config/systemd/user", unitName);
const loadedPath = `${process.env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE || "/tmp/openclaw-systemctl-shim.pid"}.loaded-unit`;
const manager = "org.freedesktop.systemd1";
const root = "/org/freedesktop/systemd1";
const object = `${root}/unit/openclaw_2dgateway_2eservice`;

function fail(message = "Unsupported survivor manager request or generated unit grammar.") {
  throw new Error(message);
}

// buildSystemdUnit quotes whole words and escapes only quotes/backslashes.
function words(value) {
  const result = [];
  const pattern = /(?:"(?:[^"\\]|\\["\\])*"|[^\s"\\]+)(?:\s+|$)/gy;
  let offset = 0;
  while (offset < value.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(value);
    if (!match) {
      fail();
    }
    const word = match[0].trimEnd();
    result.push(word.startsWith('"') ? word.slice(1, -1).replace(/\\(["\\])/g, "$1") : word);
    offset = pattern.lastIndex;
  }
  return result.map((word) =>
    word.replace(/%%|%h|%/g, (specifier) => {
      if (specifier === "%") {
        fail();
      }
      return specifier === "%h" ? process.env.HOME : "%";
    }),
  );
}

function assignments(values) {
  return Object.fromEntries(
    values.map((value) => {
      const separator = value.indexOf("=");
      if (separator <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.slice(0, separator))) {
        fail();
      }
      return [value.slice(0, separator), value.slice(separator + 1)];
    }),
  );
}

function parseUnit(content) {
  const directives = new Map();
  let section = "";
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[")) {
      section = line;
      continue;
    }
    if (section !== "[Service]") {
      continue;
    }
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (separator < 0) {
      fail();
    }
    const values = directives.get(key) || [];
    values.push(line.slice(separator + 1));
    directives.set(key, values);
  }
  const single = (key) => {
    const values = directives.get(key) || [];
    if (values.length > 1) {
      fail();
    }
    return values[0] || "";
  };
  const programArguments = words(single("ExecStart"));
  if (!programArguments.length || !path.isAbsolute(programArguments[0])) {
    fail();
  }
  const workingDirectories = words(single("WorkingDirectory"));
  if (workingDirectories.length > 1) {
    fail();
  }
  const environment = assignments(
    (directives.get("Environment") || []).flatMap((value) => {
      if (!value) {
        fail();
      }
      return words(value);
    }),
  );
  const environmentFiles = (directives.get("EnvironmentFile") || []).map((value) => {
    const optional = value.startsWith("-");
    const filenames = words(optional ? value.slice(1) : value);
    if (filenames.length !== 1 || !path.isAbsolute(filenames[0])) {
      fail();
    }
    return [filenames[0], optional];
  });
  const supported = new Set([
    "ExecStart",
    "WorkingDirectory",
    "Environment",
    "EnvironmentFile",
    "Restart",
    "RestartSec",
    "RestartPreventExitStatus",
    "TimeoutStopSec",
    "TimeoutStartSec",
    "SuccessExitStatus",
    "OOMPolicy",
    "KillMode",
  ]);
  if ([...directives.keys()].some((key) => !supported.has(key))) {
    fail();
  }
  return {
    programArguments,
    workingDirectory: workingDirectories[0] || "",
    environment,
    environmentFiles,
  };
}

function readUnit(reload = false) {
  for (const directory of [`${unitPath}.d`, path.join(path.dirname(unitPath), "service.d")]) {
    if (fs.existsSync(directory) && fs.readdirSync(directory).length) {
      fail();
    }
  }
  let content;
  try {
    content = fs.readFileSync(unitPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    fs.rmSync(loadedPath, { force: true });
    return null;
  }
  parseUnit(content);
  // Keep the manager's loaded command until daemon-reload; file edits alone do not activate it.
  if (reload || !fs.existsSync(loadedPath)) {
    fs.writeFileSync(loadedPath, content);
  }
  const loaded = fs.readFileSync(loadedPath, "utf8");
  return { ...parseUnit(loaded), reloadPending: loaded !== content };
}

function writeProperties(properties) {
  for (const [type, data] of properties) {
    console.log(JSON.stringify({ type, data }));
  }
}

function run() {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === "reload" && !args.length) {
    readUnit(true);
    return;
  }
  if (operation === "command" && !args.length) {
    const unit = readUnit();
    if (!unit) {
      fail("Cannot launch an absent fixture unit.");
    }
    const environment = { ...unit.environment };
    for (const [filename, optional] of unit.environmentFiles) {
      let content;
      try {
        content = fs.readFileSync(filename, "utf8");
      } catch (error) {
        if (optional && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim() || line.startsWith("#")) {
          continue;
        }
        const separator = line.indexOf("=");
        if (separator <= 0) {
          fail();
        }
        const raw = line.slice(separator + 1);
        // serializeSystemdEnvironmentFile escapes exactly these four characters.
        const value =
          raw.startsWith('"') && raw.endsWith('"')
            ? raw.slice(1, -1).replace(/\\(["\\`$])/g, "$1")
            : raw;
        Object.assign(environment, assignments([`${line.slice(0, separator)}=${value}`]));
      }
    }
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = [
      "env",
      ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
      ...unit.programArguments,
    ];
    console.log(
      `cd ${quote(unit.workingDirectory || process.env.HOME)} && exec ${command.map(quote).join(" ")}`,
    );
    return;
  }
  if (operation !== "busctl") {
    fail();
  }
  const matches = (expected) =>
    args.length === expected.length && args.every((arg, index) => arg === expected[index]);
  const prefix = ["--user", "--json=short"];
  const load = matches([
    ...prefix,
    "call",
    manager,
    root,
    `${manager}.Manager`,
    "LoadUnit",
    "s",
    unitName,
  ]);
  const unitQuery = matches([
    ...prefix,
    "get-property",
    manager,
    object,
    `${manager}.Unit`,
    "FragmentPath",
    "DropInPaths",
    "NeedDaemonReload",
    "LoadState",
  ]);
  const serviceQuery = matches([
    ...prefix,
    "get-property",
    manager,
    object,
    `${manager}.Service`,
    "ExecStart",
    "WorkingDirectory",
    "Environment",
    "EnvironmentFiles",
    "UnsetEnvironment",
  ]);
  if (!load && !unitQuery && !serviceQuery) {
    fail();
  }
  const unit = readUnit();
  if (!unit) {
    if (load) {
      fail(`Call failed: Unit ${unitName} not found.`);
    }
    fail("Fixture unit is not loaded.");
  }
  if (load) {
    writeProperties([["o", [object]]]);
  } else if (unitQuery) {
    writeProperties([
      ["s", unitPath],
      ["as", []],
      ["b", unit.reloadPending],
      ["s", "loaded"],
    ]);
  } else {
    writeProperties([
      [
        "a(sasbttttuii)",
        [[unit.programArguments[0], unit.programArguments, false, 0, 0, 0, 0, 0, 0, 0]],
      ],
      ["s", unit.workingDirectory],
      ["as", Object.entries(unit.environment).map(([key, value]) => `${key}=${value}`)],
      ["a(sb)", unit.environmentFiles],
      ["as", []],
    ]);
  }
}

try {
  run();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
