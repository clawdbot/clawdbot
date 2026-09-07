import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import path from "node:path";

function readText(filename) {
  try {
    return { readable: true, text: readFileSync(filename, "utf8") };
  } catch (error) {
    return { readable: false, missing: error.code === "ENOENT" };
  }
}

function command(executable, args, env = process.env, timeout = 3000) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout, env });
  return {
    available: result.error?.code !== "ENOENT",
    completed: result.status !== null,
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function executableAvailable(executable) {
  return process.env.PATH.split(path.delimiter).some((directory) => {
    try {
      accessSync(path.join(directory, executable), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

const uid = process.getuid();
const account = command("getent", ["passwd", String(uid)]);
const accountName = account.exitCode === 0 ? account.stdout.split(":")[0] : undefined;

function subordinateIds(filename) {
  const contents = readText(filename);
  if (!contents.readable) {
    return { readable: false, missing: contents.missing };
  }
  const ranges = contents.text
    .split("\n")
    .map((line) => line.split(":"))
    .filter(([owner]) => owner === accountName || owner === String(uid));
  return {
    readable: true,
    accountEntriesPresent: ranges.length > 0,
    rangeSufficient: ranges.some(
      ([, start, count]) => /^\d+$/u.test(start) && /^\d+$/u.test(count) && Number(count) >= 65536,
    ),
  };
}

function controllers(filename) {
  const contents = readText(filename);
  if (!contents.readable) {
    return { readable: false, missing: contents.missing };
  }
  const names = contents.text.trim().split(/\s+/u);
  return {
    readable: true,
    cpu: names.includes("cpu"),
    memory: names.includes("memory"),
    pids: names.includes("pids"),
  };
}

function policy(filename) {
  const contents = readText(filename);
  if (!contents.readable) {
    return { readable: false, missing: contents.missing };
  }
  return { readable: true, value: Number(contents.text.trim()) };
}

const userService = command("systemctl", [
  "show",
  `user@${uid}.service`,
  "--property=ActiveState",
  "--property=Delegate",
  "--property=ControlGroup",
]);
const properties = Object.fromEntries(
  userService.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const userManager = command("systemctl", ["--user", "is-system-running"], {
  ...process.env,
  XDG_RUNTIME_DIR: `/run/user/${uid}`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
});
const userManagerState = userManager.stdout.trim();
const packages = [
  "docker-ce",
  "docker-ce-rootless-extras",
  "rootlesskit",
  "uidmap",
  "podman",
  "slirp4netns",
  "passt",
  "fuse-overlayfs",
];
const packageQuery = command("dpkg-query", [
  "-W",
  "-f=${binary:Package}\t${Version}\t${db:Status-Status}\n",
  ...packages,
]);
const installedPackages = Object.fromEntries(packages.map((name) => [name, { installed: false }]));
for (const line of packageQuery.stdout.trim().split("\n")) {
  const [packageName, version, status] = line.split("\t");
  const name = packageName.split(":")[0];
  if (packages.includes(name) && status === "installed") {
    installedPackages[name] = { installed: true, version };
  }
}

const engine = installedPackages["docker-ce"];
const rootlessInstall = engine.installed
  ? command(
      "apt-get",
      [
        "-s",
        "--no-upgrade",
        "--no-install-recommends",
        "install",
        `docker-ce-rootless-extras=${engine.version}`,
        "uidmap",
        "slirp4netns",
      ],
      process.env,
      10000,
    )
  : undefined;

let packageIndexRefresh;
let refreshedRootlessInstall;
if (
  rootlessInstall?.exitCode === 100 &&
  process.env.GITHUB_ACTIONS === "true" &&
  !existsSync("/.dockerenv")
) {
  packageIndexRefresh = command(
    "timeout",
    ["--foreground", "--kill-after=10s", "120s", "sudo", "-n", "apt-get", "update"],
    process.env,
    135000,
  );
  if (packageIndexRefresh.exitCode === 0) {
    refreshedRootlessInstall = command(
      "apt-get",
      [
        "-s",
        "--no-upgrade",
        "--no-install-recommends",
        "install",
        `docker-ce-rootless-extras=${engine.version}`,
        "uidmap",
        "slirp4netns",
      ],
      process.env,
      10000,
    );
  }
}

function packageObservation(result) {
  if (!result) {
    return { attempted: false };
  }
  return {
    commandAvailable: result.available,
    completed: result.completed,
    exitCode: result.exitCode,
    output: result.stdout.replace(/https?:\/\/\S+/gu, "[package source]"),
    errorOutput: result.stderr.replace(/https?:\/\/\S+/gu, "[package source]"),
  };
}

// Report only selected facts: command output can contain account names and host paths.
console.log(
  JSON.stringify({
    kind: "fleet-runtime-prerequisites",
    reportCompleted: true,
    runtimeControlsExecuted: false,
    hostAccount: { nonRoot: uid !== 0, resolved: account.exitCode === 0 },
    subordinateIds: {
      source: "local-files",
      uid: subordinateIds("/etc/subuid"),
      gid: subordinateIds("/etc/subgid"),
    },
    cgroup: {
      rootControllers: controllers("/sys/fs/cgroup/cgroup.controllers"),
      userControllers:
        userService.exitCode === 0 && properties.ControlGroup
          ? controllers(path.join("/sys/fs/cgroup", properties.ControlGroup, "cgroup.controllers"))
          : { observed: false },
    },
    userSystemd: {
      commandAvailable: userService.available,
      serviceObserved: userService.exitCode === 0,
      serviceActive: properties.ActiveState === "active",
      delegationEnabled: properties.Delegate === "yes",
      managerQueryCompleted: userManager.completed,
      managerResponding: [
        "initializing",
        "starting",
        "running",
        "degraded",
        "maintenance",
        "stopping",
        "offline",
      ].includes(userManagerState),
      managerRunning: userManagerState === "running" || userManagerState === "degraded",
    },
    executables: Object.fromEntries(
      [
        "dockerd-rootless.sh",
        "rootlesskit",
        "newuidmap",
        "newgidmap",
        "podman",
        "slirp4netns",
        "pasta",
      ].map((name) => [name, executableAvailable(name)]),
    ),
    packages: {
      queryAvailable: packageQuery.available,
      queryCompleted: packageQuery.completed,
      installed: installedPackages,
    },
    dockerRootlessInstallSimulation: packageObservation(rootlessInstall),
    packageIndexRefresh: packageObservation(packageIndexRefresh),
    refreshedDockerRootlessInstallSimulation: packageObservation(refreshedRootlessInstall),
    policy: {
      unprivilegedUsernsClone: policy("/proc/sys/kernel/unprivileged_userns_clone"),
      maxUserNamespaces: policy("/proc/sys/user/max_user_namespaces"),
      apparmorRestrictsUserns: policy("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
    },
  }),
);
