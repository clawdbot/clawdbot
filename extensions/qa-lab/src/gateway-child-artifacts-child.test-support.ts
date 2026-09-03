import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  openOpenClawAgentDatabase,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { cleanupQaGatewayTempRoots } from "./gateway-child-artifacts.js";
import { stageQaLiveApiKeyProfiles } from "./providers/live-frontier/auth.js";
import { readQaAuthProfiles } from "./providers/shared/auth-store.js";

const [tempRoot, stagedBundledPluginsRoot] = process.argv.slice(2);
if (!tempRoot || !stagedBundledPluginsRoot) {
  throw new Error("Expected runtime and staging roots");
}
const roots = [tempRoot, `${tempRoot}-sibling`];
await Promise.all(
  roots.map((root) =>
    stageQaLiveApiKeyProfiles({
      cfg: {},
      stateDir: path.join(root, "state"),
      providerIds: ["openai"],
      env: { OPENAI_API_KEY: "qa-fake-not-a-real-key" },
    }),
  ),
);
const stores = roots.map((root) => {
  const stateDir = path.join(root, "state");
  const agentDir = path.join(stateDir, "agents", "qa", "agent");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  return {
    agentDir,
    agent: openOpenClawAgentDatabase({
      agentId: "qa",
      env,
      path: path.join(agentDir, "openclaw-agent.sqlite"),
    }),
    shared: openOpenClawStateDatabase({ env }),
    profiles: readQaAuthProfiles(agentDir),
  };
});
const sibling = stores[1];
const leases = () =>
  sibling.shared.db.prepare("SELECT * FROM agent_database_leases ORDER BY lease_id").all();
const beforeLeases = leases();
await cleanupQaGatewayTempRoots({ tempRoot, stagedBundledPluginsRoot });
assert.equal(fs.existsSync(tempRoot), false);
assert.equal(sibling.agent.db.isOpen, true);
assert.equal(sibling.shared.db.isOpen, true);
assert.deepEqual(readQaAuthProfiles(sibling.agentDir), sibling.profiles);
assert.deepEqual(leases(), beforeLeases);
process.stdout.write(
  JSON.stringify({
    targetClosed: !stores[0].agent.db.isOpen && !stores[0].shared.db.isOpen,
    siblingUsable: true,
  }),
);
