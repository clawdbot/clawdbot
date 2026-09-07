import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatPluginLine } from "../cli/plugins-list-format.js";
import { VERSION } from "../version.js";
import { createPluginRecord, recordPluginError } from "./loader-records.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.cleanup());

it.each([
  { name: "missing export", nestedSdk: false, wrapped: false },
  { name: "wrapped missing export", nestedSdk: false, wrapped: true },
  { name: "nested SDK", nestedSdk: true, wrapped: false },
  { name: "wrapped nested SDK", nestedSdk: true, wrapped: true },
  {
    name: "channel setup classification",
    nestedSdk: true,
    wrapped: false,
    diagnosticCode: "channel-setup-failure" as const,
  },
  {
    name: "plugin id requiring quoting",
    nestedSdk: false,
    wrapped: false,
    pluginId: "custom plugin",
  },
])("diagnoses $name", ({ nestedSdk, wrapped, diagnosticCode, pluginId }) => {
  const project = tempDirs.make("openclaw-sdk-skew-");
  const id = pluginId ?? (nestedSdk ? "third-party-fixture" : "whatsapp");
  const packageName = nestedSdk ? "@fixture/third-party" : "@openclaw/whatsapp";
  const rootDir = path.join(project, "node_modules", packageName);
  const sdkRoot = path.join(nestedSdk ? rootDir : project, "node_modules", "openclaw");
  const seam = `openclaw/plugin-sdk/${nestedSdk ? "channel-runtime" : "agent-harness-runtime"}`;
  const write = (target: string, content: string) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write(
    path.join(project, "package.json"),
    JSON.stringify({ dependencies: { [packageName]: "2026.7.1" } }),
  );
  write(
    path.join(rootDir, "package.json"),
    JSON.stringify({ name: packageName, version: "2026.7.1", type: "module" }),
  );
  write(
    path.join(sdkRoot, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: nestedSdk ? "2026.7.1" : VERSION,
      type: "module",
      exports: nestedSdk ? {} : { "./plugin-sdk/agent-harness-runtime": "./runtime.mjs" },
    }),
  );
  write(path.join(sdkRoot, "runtime.mjs"), "export const available = true;");
  const source = path.join(rootDir, "index.mjs");
  write(
    source,
    nestedSdk
      ? `import ${JSON.stringify(seam)};`
      : `import { MISSING_FIXTURE_EXPORT } from ${JSON.stringify(seam)}; export default MISSING_FIXTURE_EXPORT;`,
  );
  // Native Node supplies the real error shape, without the host test process's SDK aliases.
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'try { await import(process.argv[1]); console.log("null"); } catch (error) { console.log(JSON.stringify({name:error.name,message:error.message,code:error.code})); }',
        pathToFileURL(source).href,
      ],
      { encoding: "utf8" },
    ),
  );
  expect(result).toMatchObject(
    nestedSdk ? { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" } : { name: "SyntaxError" },
  );
  const nativeError = Object.assign(new Error(result.message), {
    name: result.name,
    code: result.code,
  });
  const error = wrapped ? new Error("native import failed", { cause: nativeError }) : nativeError;
  const record = createPluginRecord({
    id,
    packageName,
    source,
    rootDir,
    packageVersion: "2026.7.1",
    builtWithOpenClawVersion: "2026.7.1",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  const registry = createEmptyPluginRegistry();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  recordPluginError({
    logger,
    registry,
    record,
    seenIds: new Map(),
    phase: "load",
    diagnosticCode,
    error,
    logPrefix: "",
    diagnosticMessagePrefix: "",
  });
  expect(logger.error).toHaveBeenCalledTimes(1);
  expect(registry.diagnostics).toHaveLength(1);
  expect(registry.diagnostics[0]).toMatchObject({
    pluginId: id,
    code: diagnosticCode ?? "sdk-incompatible",
    sdkCompatibility: {
      seam,
      coreVersion: VERSION,
      builtWithOpenClawVersion: "2026.7.1",
      nestedSdk,
    },
  });
  const action = nestedSdk
    ? "this plugin bundles an incompatible OpenClaw SDK; update it or contact its author"
    : pluginId
      ? "update this plugin or contact its author"
      : "run `openclaw plugins update whatsapp`";
  for (const text of [
    record.error,
    formatPluginLine(record),
    registry.diagnostics[0]?.message,
    logger.error.mock.calls[0]?.[0],
  ]) {
    expect(text).toContain(id);
    expect(text).toContain(seam);
    expect(text).toContain(VERSION);
    expect(text).toContain(action);
  }
});
