import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [cliEntry, engineRoot, runtimeRoot, observedInfoFile] = process.argv.slice(2);
const { parse, stringify, TomlError } = createRequire(cliEntry)("smol-toml");
const filename = observedInfoFile
  ? path.join(engineRoot, "storage.conf")
  : ["/etc/containers/storage.conf", "/usr/share/containers/storage.conf"].find((name) =>
      fs.existsSync(name),
    );
let config = {};
if (filename) {
  try {
    config = parse(fs.readFileSync(filename, "utf8"), { integersAsBigInt: true });
  } catch (error) {
    if (!(error instanceof TomlError)) {
      throw error;
    }
    console.error(
      JSON.stringify({ control: "podman", attempted: false, error: "invalid-storage-toml" }),
    );
    process.exit(1);
  }
}
config.storage ??= {};
if (observedInfoFile && !config.storage.driver) {
  const info = JSON.parse(fs.readFileSync(observedInfoFile, "utf8"));
  // The layer-mapping reexec treats even a successful child's warning output as an error.
  config.storage.driver = info.store.graphDriverName;
}
for (const [key, value] of [
  ["storage.imagestore", config.storage.imagestore],
  ["storage.options.imagestore", config.storage.options?.imagestore],
]) {
  if (value) {
    console.error(
      JSON.stringify({
        control: "podman",
        attempted: false,
        missingCapability: "isolated-additional-writable-image-store",
        setting: key,
      }),
    );
    process.exit(78);
  }
}

// Preserve driver selection and all driver options; only relocate the writable task roots.
config.storage.graphroot = path.join(engineRoot, "data", "containers", "storage");
config.storage.runroot = path.join(runtimeRoot, "containers");
config.storage.rootless_storage_path = config.storage.graphroot;
fs.writeFileSync(
  path.join(engineRoot, "storage.conf"),
  stringify(config, { numbersAsFloat: true }),
  {
    mode: 0o600,
  },
);
