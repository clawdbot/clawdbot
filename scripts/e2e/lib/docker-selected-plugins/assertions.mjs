import fs from "node:fs";
import path from "node:path";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertFile(filePath) {
  assert(fs.statSync(filePath).isFile(), `expected file: ${filePath}`);
}

function assertAbsent(filePath) {
  assert(!fs.existsSync(filePath), `expected path to be absent: ${filePath}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const selected = {
  clickclack: {
    entries: ["index.js"],
    capability: "channel",
  },
  slack: {
    entries: ["index.js", "setup-entry.js"],
    capability: "channel",
  },
  msteams: {
    entries: ["index.js", "setup-entry.js"],
    capability: "channel",
  },
  clawrouter: {
    entries: ["index.js"],
    capability: "text-inference",
  },
};

const buildInfo = readJson("/app/dist/build-info.json");
const expectedCommit = process.env.OPENCLAW_E2E_EXPECTED_GIT_COMMIT?.toLowerCase();
const expectedBuiltAt = new Date(
  process.env.OPENCLAW_E2E_EXPECTED_BUILD_TIMESTAMP ?? "",
).toISOString();
assert(buildInfo.commit === expectedCommit, `unexpected build commit: ${buildInfo.commit}`);
assert(buildInfo.builtAt === expectedBuiltAt, `unexpected build timestamp: ${buildInfo.builtAt}`);

for (const [pluginId, expected] of Object.entries(selected)) {
  const pluginRoot = path.join("/app/dist/extensions", pluginId);
  for (const entry of expected.entries) {
    assertFile(path.join(pluginRoot, entry));
  }
  assertFile(path.join(pluginRoot, "openclaw.plugin.json"));
  assertFile(path.join(pluginRoot, "package.json"));

  const manifest = readJson(path.join(pluginRoot, "openclaw.plugin.json"));
  const packageJson = readJson(path.join(pluginRoot, "package.json"));
  assert(manifest.id === pluginId, `unexpected ${pluginId} manifest id: ${manifest.id}`);
  assert(
    packageJson.openclaw?.extensions?.includes("./index.js"),
    `${pluginId} package entry was not rewritten to ./index.js`,
  );
  if (expected.entries.includes("setup-entry.js")) {
    assert(
      packageJson.openclaw?.setupEntry === "./setup-entry.js",
      `${pluginId} setup entry was not rewritten to ./setup-entry.js`,
    );
  }

  const inspect = readJson(`/tmp/openclaw-${pluginId}-inspect.json`);
  assert(inspect.plugin?.id === pluginId, `unexpected ${pluginId} inspect id`);
  assert(inspect.plugin?.status === "loaded", `${pluginId} runtime did not load`);
  assert(inspect.plugin?.origin === "bundled", `${pluginId} did not load from bundled dist`);
  assert(
    inspect.capabilities?.some(
      (entry) => entry?.kind === expected.capability && entry.ids?.includes(pluginId),
    ),
    `${pluginId} did not register ${expected.capability} capability`,
  );
}

for (const pluginId of ["clickclack", "slack"]) {
  const packageJson = readJson(`/app/dist/extensions/${pluginId}/package.json`);
  assert(
    packageJson.openclaw?.build?.bundledDist === false,
    `${pluginId} bundledDist release metadata changed`,
  );
}

const declaredDependencies = {
  clickclack: ["ws"],
  slack: ["@slack/bolt", "@slack/web-api"],
  msteams: ["@microsoft/teams.apps"],
};
for (const [pluginId, dependencies] of Object.entries(declaredDependencies)) {
  const packageJson = readJson(`/app/dist/extensions/${pluginId}/package.json`);
  for (const dependency of dependencies) {
    assert(
      typeof packageJson.dependencies?.[dependency] === "string",
      `${pluginId} package metadata omitted ${dependency}`,
    );
  }
}

for (const dependency of ["@microsoft/teams.apps", "@slack/bolt", "@slack/web-api", "ws"]) {
  assertFile(path.join("/app/node_modules", dependency, "package.json"));
}

assertFile("/app/dist/extensions/slack/skills/slack/SKILL.md");
assertAbsent("/app/dist/extensions/amazon-bedrock");
assertAbsent("/app/extensions/amazon-bedrock");
assertAbsent("/app/node_modules/@aws-sdk/client-bedrock");
assertAbsent("/app/dist/extensions/signal");
assertAbsent("/app/extensions/signal");
assertAbsent("/home/node/.cache/ms-playwright");

console.log(`Selected-plugin runtime proof passed (${process.arch})`);
