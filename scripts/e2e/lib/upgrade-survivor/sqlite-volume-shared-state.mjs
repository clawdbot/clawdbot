import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const VOLUME_PLUGIN_ID = "upgrade-survivor";
const VOLUME_PLUGIN_NAMESPACES = ["archive-cursors", "operator-preferences"];
const VOLUME_PLUGIN_ENTRIES_PER_NAMESPACE = 256;
const VOLUME_PAIRING_ACCOUNTS = [
  {
    accountId: "default",
    code: "UPGRADE2",
    allowFrom: ["444444444444444444", "555555555555555555"],
  },
  {
    accountId: "upgrade-work",
    code: "UPGRADE3",
    allowFrom: ["444444444444444444", "666666666666666666"],
  },
];
const VOLUME_WORKSPACE_FILES = new Map([
  [
    "IDENTITY.md",
    "# Upgrade Survivor\n\nThis workspace must survive package update and doctor repair.\n",
  ],
  ["SOUL.md", "# Existing soul\n\nKeep the operator's voice — 東京.\n"],
  ["USER.md", "# Existing user\n\nPrefers complete migration evidence.\n"],
  ["MEMORY.md", "# Existing memory\n\nThe archive cursor belongs to partition λ.\n"],
]);

function assertJsonEqual(actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function writeJson(file, value) {
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function withReadonlySharedDatabase(stateDir, operation) {
  const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), { readOnly: true });
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function readVolumePluginRows(db) {
  return db
    .prepare(
      "SELECT plugin_id, namespace, entry_key, value_json, created_at, expires_at FROM plugin_state_entries WHERE plugin_id = ? ORDER BY namespace, entry_key",
    )
    .all(VOLUME_PLUGIN_ID);
}

function getVolumePluginValue(namespace, index) {
  return {
    namespace,
    index,
    label: `Archive partition ${index} — 東京`,
    enabled: index % 3 !== 0,
    cursor: { offset: index * 1000, previous: index === 0 ? null : index - 1 },
    tags: ["survivor", `partition-${index % 17}`],
  };
}

function sharedSchemaSnapshot(db) {
  const schema = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
  return {
    schemaVersion: db.prepare("PRAGMA user_version").get().user_version,
    metadata: db
      .prepare(
        "SELECT role, agent_id, schema_version, app_version FROM schema_meta WHERE meta_key = 'primary'",
      )
      .get(),
    schemaSha256: createHash("sha256").update(JSON.stringify(schema)).digest("hex"),
  };
}

function recordBaselineSharedState(stateDir, snapshot) {
  const baselinePath = path.join(stateDir, "survivor-baseline.json");
  writeJson(baselinePath, { ...readJson(baselinePath), sharedState: snapshot });
}

async function seedBaselinePluginState(packageRoot) {
  assert(packageRoot, "seed-baseline-plugin-state requires the installed baseline package root");
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  assert(stateDir, "baseline plugin state requires OPENCLAW_STATE_DIR");
  const packageJsonPath = path.join(path.resolve(packageRoot), "package.json");
  const manifest = readJson(packageJsonPath);
  assert.equal(
    manifest.name,
    "openclaw",
    "baseline SDK must belong to the installed OpenClaw package",
  );
  assert.equal(
    manifest.version,
    process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION,
    "baseline SDK package version differs from the installed CLI",
  );
  const sdkExport = manifest.exports?.["./plugin-sdk/runtime-doctor"];
  let hasStoreDeclaration = false;
  if (sdkExport) {
    assert.equal(typeof sdkExport.types, "string", "baseline doctor SDK type declaration missing");
    const declarations = fs.readFileSync(path.resolve(packageRoot, sdkExport.types), "utf8");
    hasStoreDeclaration = /\bcreatePluginStateSyncKeyedStore\b/u.test(declarations);
  }
  // April/May baselines expose doctor helpers but no keyed store constructor.
  // A declared constructor whose runtime import is broken must still fail below.
  if (!hasStoreDeclaration) {
    const reason = "baseline SDK does not declare createPluginStateSyncKeyedStore";
    recordBaselineSharedState(stateDir, {
      status: "not-applicable",
      packageVersion: manifest.version,
      reason,
    });
    process.stdout.write(
      `sqlite-volume-baseline package=${manifest.version} not-applicable: ${reason}\n`,
    );
    return;
  }
  const installedRequire = createRequire(packageJsonPath);
  // Resolve the published SDK from its own package; importing checkout source would
  // silently create the candidate schema and erase the upgrade boundary under test.
  const sdkUrl = pathToFileURL(installedRequire.resolve("openclaw/plugin-sdk/runtime-doctor"));
  const { createPluginStateSyncKeyedStore } = await import(sdkUrl.href);
  assert.equal(
    typeof createPluginStateSyncKeyedStore,
    "function",
    "baseline doctor SDK declared a keyed store constructor but did not export it",
  );
  for (const namespace of VOLUME_PLUGIN_NAMESPACES) {
    const store = createPluginStateSyncKeyedStore(VOLUME_PLUGIN_ID, {
      namespace,
      maxEntries: VOLUME_PLUGIN_ENTRIES_PER_NAMESPACE,
      overflowPolicy: "reject-new",
      env: process.env,
    });
    for (let index = 0; index < VOLUME_PLUGIN_ENTRIES_PER_NAMESPACE; index += 1) {
      const key = `entry-${String(index).padStart(4, "0")}`;
      const value = getVolumePluginValue(namespace, index);
      store.register(key, value);
      assert.deepEqual(
        store.lookup(key),
        value,
        `baseline plugin SDK readback changed: ${namespace}/${key}`,
      );
    }
  }
  const snapshot = withReadonlySharedDatabase(stateDir, (db) => {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    const schema = sharedSchemaSnapshot(db);
    assert.equal(schema.metadata.role, "global");
    assert.equal(schema.metadata.schema_version, schema.schemaVersion);
    const pluginRows = readVolumePluginRows(db);
    assert(
      pluginRows.every((row) => row.expires_at === null),
      "baseline plugin fixture must not expire",
    );
    return { status: "seeded", packageVersion: manifest.version, ...schema, pluginRows };
  });
  recordBaselineSharedState(stateDir, snapshot);
  process.stdout.write(
    `sqlite-volume-baseline package=${manifest.version} schema=${snapshot.schemaVersion} pluginRows=${snapshot.pluginRows.length}\n`,
  );
}

function assertVolumePluginState(stateDir, stage) {
  const snapshot = readJson(path.join(stateDir, "survivor-baseline.json")).sharedState;
  assert(snapshot, "published baseline shared database snapshot missing");
  if (snapshot.status === "not-applicable") {
    assert.equal(snapshot.reason, "baseline SDK does not declare createPluginStateSyncKeyedStore");
    return;
  }
  assert.equal(snapshot.status, "seeded", "published shared database fixture was not seeded");
  assert.equal(
    snapshot.pluginRows.length,
    VOLUME_PLUGIN_NAMESPACES.length * VOLUME_PLUGIN_ENTRIES_PER_NAMESPACE,
  );
  withReadonlySharedDatabase(stateDir, (db) => {
    if (stage === "baseline") {
      assertJsonEqual(
        sharedSchemaSnapshot(db),
        {
          schemaVersion: snapshot.schemaVersion,
          metadata: snapshot.metadata,
          schemaSha256: snapshot.schemaSha256,
        },
        "published baseline shared schema changed before update",
      );
    }
    assertJsonEqual(
      readVolumePluginRows(db),
      snapshot.pluginRows,
      "published plugin state changed during update or restart",
    );
  });
}

function getVolumePairingRequests(createdAt) {
  return VOLUME_PAIRING_ACCOUNTS.map(({ accountId, code }) => ({
    id: "777777777777777777",
    code,
    createdAt,
    lastSeenAt: createdAt,
    meta: { accountId, username: "Pending user — 東京" },
  }));
}

function seedUpgradeVolumePairing(stateDir) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  assert(configPath, "volume pairing fixture requires OPENCLAW_CONFIG_PATH");
  const config = readJson(configPath);
  const discord = config.channels?.discord;
  assert(discord, "volume pairing fixture requires configured Discord");
  discord.defaultAccount = "default";
  discord.accounts = { default: {}, "upgrade-work": { enabled: false } };
  writeJson(configPath, config);
  const createdAt = new Date().toISOString();
  const baselinePath = path.join(stateDir, "survivor-baseline.json");
  writeJson(baselinePath, { ...readJson(baselinePath), pairingCreatedAt: createdAt });
  const credentialsDir = path.join(stateDir, "credentials");
  // v2026.7.1-2 stores requests together but allowlists in account-scoped files.
  writeJson(path.join(credentialsDir, "discord-pairing.json"), {
    version: 1,
    requests: getVolumePairingRequests(createdAt),
  });
  for (const { accountId, allowFrom } of VOLUME_PAIRING_ACCOUNTS) {
    writeJson(path.join(credentialsDir, `discord-${accountId}-allowFrom.json`), {
      version: 1,
      allowFrom,
    });
  }
}

function assertUpgradeVolumePairing(stateDir, stage) {
  const createdAt = readJson(path.join(stateDir, "survivor-baseline.json")).pairingCreatedAt;
  assert(typeof createdAt === "string", "volume pairing fixture timestamp missing");
  const requests = getVolumePairingRequests(createdAt);
  const sources = new Map([
    ["discord-pairing.json", { version: 1, requests }],
    ...VOLUME_PAIRING_ACCOUNTS.map(({ accountId, allowFrom }) => [
      `discord-${accountId}-allowFrom.json`,
      { version: 1, allowFrom },
    ]),
  ]);
  for (const [filename, expected] of sources) {
    const sourcePath = path.join(stateDir, "credentials", filename);
    if (stage === "baseline") {
      assertJsonEqual(readJson(sourcePath), expected, `volume pairing source changed: ${filename}`);
    } else {
      assert(!fs.existsSync(sourcePath), `volume pairing source remained active: ${filename}`);
    }
  }
  if (stage === "baseline") {
    return;
  }
  withReadonlySharedDatabase(stateDir, (db) => {
    const rows = db
      .prepare(
        "SELECT account_id, request_id, code, created_at, last_seen_at, meta_json FROM channel_pairing_requests WHERE channel_key = 'discord' ORDER BY account_id",
      )
      .all();
    assertJsonEqual(
      rows.map((row) => row.account_id),
      VOLUME_PAIRING_ACCOUNTS.map(({ accountId }) => accountId),
      "volume pairing request account ownership changed",
    );
    assertJsonEqual(
      rows.map((row) => ({
        id: row.request_id,
        code: row.code,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        meta: JSON.parse(row.meta_json),
      })),
      requests,
      "volume pairing requests changed or crossed accounts",
    );
    const entries = db
      .prepare(
        "SELECT account_id, entry FROM channel_pairing_allow_entries WHERE channel_key = 'discord' ORDER BY account_id, sort_order",
      )
      .all();
    assertJsonEqual(
      entries,
      VOLUME_PAIRING_ACCOUNTS.flatMap(({ accountId, allowFrom }) =>
        allowFrom.map((entry) => ({ account_id: accountId, entry })),
      ),
      "volume pairing allowlists changed or crossed accounts",
    );
  });
}

export function seedUpgradeVolumeSharedState(stateDir) {
  seedUpgradeVolumePairing(stateDir);
  const workspace = process.env.OPENCLAW_TEST_WORKSPACE_DIR;
  assert(workspace, "volume fixture requires OPENCLAW_TEST_WORKSPACE_DIR");
  for (const [filename, contents] of VOLUME_WORKSPACE_FILES) {
    write(path.join(workspace, filename), contents);
  }
}

export function assertUpgradeVolumeSharedState(stateDir, stage) {
  assertVolumePluginState(stateDir, stage);
  assertUpgradeVolumePairing(stateDir, stage);
  const workspace = process.env.OPENCLAW_TEST_WORKSPACE_DIR;
  assert(workspace, "volume fixture requires OPENCLAW_TEST_WORKSPACE_DIR");
  for (const [filename, contents] of VOLUME_WORKSPACE_FILES) {
    assert(
      fs.readFileSync(path.join(workspace, filename), "utf8") === contents,
      `volume workspace file changed: ${filename}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, packageRoot] = process.argv.slice(2);
  assert.equal(
    command,
    "seed-baseline-plugin-state",
    "expected seed-baseline-plugin-state <package-root>",
  );
  await seedBaselinePluginState(packageRoot);
}
