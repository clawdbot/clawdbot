import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const proofStorageBytes = 32 * 1024 ** 3;
const containerConfiguration =
  '[containers]\nlog_driver = "k8s-file"\nlog_size_max = 1048576\n' +
  '[network]\ndefault_rootless_network_cmd = "slirp4netns"\n';
export function proofImageTag(image: string) {
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(image)) {
    throw new Error("Invalid immutable image identity");
  }
  return `localhost/mantis-proof-${image.replace(/^sha256:/, "")}:candidate`;
}
export function assertProofImage(expected: string, actual: string) {
  proofImageTag(expected);
  proofImageTag(actual);
  if (expected.replace(/^sha256:/, "") !== actual.replace(/^sha256:/, "")) {
    throw new Error("Prepared image identity changed");
  }
}
const manifestSchema = z.strictObject({
  schema: z.literal("mantis.podman-storage.v1"),
  root: z.string(),
  uid: z.number().int().positive(),
  gid: z.number().int().nonnegative(),
  bytes: z.literal(proofStorageBytes),
  phase: z.enum(["initializing", "ready"]),
});
const command = (name: string, args: string[]) =>
  execFileSync(name, args, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 60_000 }).trim();
function load(rootValue: string) {
  const root = realpathSync(rootValue);
  if (
    root !== rootValue ||
    !path.basename(root).startsWith("mantis-podman-") ||
    process.getuid?.() === 0
  ) {
    throw new Error("Invalid proof storage owner/path");
  }
  const file = path.join(root, "manifest.json"),
    info = lstatSync(file);
  if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077) {
    throw new Error("Untrusted proof storage manifest");
  }
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (
    manifest.root !== root ||
    manifest.uid !== process.getuid?.() ||
    manifest.gid !== process.getgid?.()
  ) {
    throw new Error("Proof storage owner changed");
  }
  return manifest;
}
function assertMount(root: string) {
  const mount = path.join(root, "volume"),
    image = path.join(root, "storage.img");
  if (
    realpathSync(image) !== image ||
    !lstatSync(image).isFile() ||
    statSync(image).size !== proofStorageBytes
  ) {
    throw new Error("Invalid bounded storage image");
  }
  const entries = JSON.parse(
    command("findmnt", ["--json", "--mountpoint", mount, "--output", "TARGET,SOURCE,FSTYPE"]),
  ).filesystems;
  if (
    entries?.length !== 1 ||
    entries[0].target !== mount ||
    entries[0].fstype !== "ext4" ||
    !/^\/dev\/loop\d+$/.test(entries[0].source)
  ) {
    throw new Error("Bounded proof filesystem is not mounted");
  }
  const loops = JSON.parse(
    command("sudo", ["losetup", "--json", "--list", "--output", "NAME,BACK-FILE"]),
  ).loopdevices;
  if (
    !loops?.some(
      (loop: { name: string; "back-file": string }) =>
        loop.name === entries[0].source && loop["back-file"] === image,
    )
  ) {
    throw new Error("Proof mount backing identity changed");
  }
  return mount;
}
export function proofStorageEnvironment(rootValue = process.env.MANTIS_PODMAN_ROOT ?? "") {
  const manifest = load(rootValue),
    mount = assertMount(manifest.root);
  const config = path.join(manifest.root, "storage.conf");
  const expected = `[storage]\ndriver = "overlay"\nrunroot = "${mount}/runroot"\ngraphroot = "${mount}/graphroot"\n`;
  if (
    readFileSync(config, "utf8") !== expected ||
    !lstatSync(config).isFile() ||
    statSync(config).mode & 0o077
  ) {
    throw new Error("Proof storage configuration changed");
  }
  const runtime = `/run/user/${manifest.uid}`;
  const containers = path.join(manifest.root, "containers.conf");
  if (
    readFileSync(containers, "utf8") !== containerConfiguration ||
    !lstatSync(containers).isFile() ||
    statSync(containers).mode & 0o077
  ) {
    throw new Error("Bounded container configuration changed");
  }
  if (statSync(runtime).uid !== manifest.uid || !statSync(path.join(runtime, "bus")).isSocket()) {
    throw new Error("Rootless Podman requires the existing runner user session");
  }
  return {
    CONTAINERS_STORAGE_CONF: config,
    CONTAINERS_CONF: containers,
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
  };
}
export function assertPodmanProofStorage() {
  if (load(process.env.MANTIS_PODMAN_ROOT ?? "").phase !== "ready") {
    throw new Error("Proof storage initialization is incomplete");
  }
  const env = proofStorageEnvironment();
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] !== value) {
      throw new Error("Podman storage environment is not bound");
    }
  }
  const info = JSON.parse(command("podman", ["info", "--format", "json"]));
  const mount = path.join(process.env.MANTIS_PODMAN_ROOT!, "volume");
  if (
    info.host?.security?.rootless !== true ||
    info.host?.logDriver !== "k8s-file" ||
    info.host?.rootlessNetworkCmd !== "slirp4netns" ||
    info.store?.graphRoot !== `${mount}/graphroot` ||
    info.store?.runRoot !== `${mount}/runroot`
  ) {
    throw new Error("Podman escaped bounded rootless storage");
  }
  return env;
}
function setup() {
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  if (!uid || gid === undefined || process.platform !== "linux") {
    throw new Error("Proof requires a non-root Linux runner");
  }
  command("slirp4netns", ["--version"]);
  const parent = realpathSync(process.env.RUNNER_TEMP ?? "");
  const root = mkdtempSync(path.join(parent, "mantis-podman-"));
  chmodSync(root, 0o700);
  writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify({
      schema: "mantis.podman-storage.v1",
      root,
      uid,
      gid,
      bytes: proofStorageBytes,
      phase: "initializing",
    }),
    { mode: 0o600 },
  );
  // Publish cleanup identity before privileged setup; a later failure remains recoverable.
  appendFileSync(process.env.GITHUB_ENV!, `MANTIS_PODMAN_ROOT=${root}\n`);
  const image = path.join(root, "storage.img"),
    mount = path.join(root, "volume");
  writeFileSync(image, "", { mode: 0o600 });
  command("fallocate", ["--length", String(proofStorageBytes), image]);
  mkdirSync(mount, { mode: 0o700 });
  command("mkfs.ext4", ["-q", "-F", "-E", "nodiscard", image]);
  if (statSync(image).blocks * 512 < proofStorageBytes) {
    throw new Error("Proof storage backing reservation is incomplete");
  }
  command("sudo", ["mount", "-o", "loop,nodev,nosuid", image, mount]);
  command("sudo", ["chown", `${uid}:${gid}`, mount]);
  chmodSync(mount, 0o700);
  mkdirSync(path.join(mount, "graphroot"), { mode: 0o700 });
  mkdirSync(path.join(mount, "runroot"), { mode: 0o700 });
  const config = `[storage]\ndriver = "overlay"\nrunroot = "${mount}/runroot"\ngraphroot = "${mount}/graphroot"\n`;
  writeFileSync(path.join(root, "storage.conf"), config, { mode: 0o600 });
  writeFileSync(path.join(root, "containers.conf"), containerConfiguration, { mode: 0o600 });
  const environment = proofStorageEnvironment(root);
  const readyManifest = path.join(root, "manifest.ready.json");
  writeFileSync(readyManifest, JSON.stringify({ ...load(root), phase: "ready" }), { mode: 0o600 });
  renameSync(readyManifest, path.join(root, "manifest.json"));
  appendFileSync(
    process.env.GITHUB_ENV!,
    Object.entries(environment)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
  console.log("Prepared verified 32-GiB rootless Podman filesystem; no credentials acquired.");
}
function cleanupProofStorage() {
  const { root, phase } = load(process.env.MANTIS_PODMAN_ROOT ?? "");
  const mounted = spawnSync("findmnt", ["--mountpoint", path.join(root, "volume")], {
    stdio: "ignore",
    timeout: 10_000,
  });
  if (mounted.status === 1) {
    const loops = JSON.parse(
      command("sudo", ["losetup", "--json", "--list", "--output", "NAME,BACK-FILE"]),
    ).loopdevices;
    const mounts = JSON.parse(
      command("findmnt", ["--json", "--list", "--output", "TARGET"]),
    ).filesystems;
    if (
      loops.some(
        (loop: { "back-file": string }) => loop["back-file"] === path.join(root, "storage.img"),
      ) ||
      mounts.some((entry: { target: string }) => entry.target.startsWith(root + path.sep))
    ) {
      throw new Error("Partial proof storage still has mounted resources");
    }
    rmSync(root, { recursive: true });
    console.log("Removed unmounted partial proof setup after verifying no loop or mount holders.");
    return;
  }
  if (mounted.status !== 0) {
    throw new Error("Proof mount status unavailable");
  }
  assertMount(root);
  if (phase === "initializing") {
    const mounts = JSON.parse(
      command("findmnt", ["--json", "--list", "--output", "TARGET"]),
    ).filesystems;
    if (
      mounts.some(
        (entry: { target: string }) =>
          entry.target.startsWith(root + path.sep) && entry.target !== path.join(root, "volume"),
      )
    ) {
      throw new Error("Partial proof storage has nested mounts; retained for recovery");
    }
  } else {
    Object.assign(process.env, proofStorageEnvironment(root));
    assertPodmanProofStorage();
    if (command("podman", ["ps", "--all", "--quiet"])) {
      throw new Error("Proof containers remain; storage retained for recovery");
    }
  }
  // No lazy/forced unmount: live holders leave a visible inconclusive cleanup failure.
  command("sudo", ["umount", path.join(root, "volume")]);
  if (
    command("findmnt", ["--json", "--target", root, "--output", "TARGET"]).includes(
      path.join(root, "volume"),
    )
  ) {
    throw new Error("Proof mount remains");
  }
  rmSync(root, { recursive: true });
  console.log("Bounded proof storage unmounted and removed after verified lifecycle checks.");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "setup") {
    setup();
  } else if (process.argv[2] === "cleanup") {
    cleanupProofStorage();
  } else {
    throw new Error("Usage: telegram-proof-storage.mts setup|cleanup");
  }
}
