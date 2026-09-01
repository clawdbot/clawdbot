import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import {
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  normalizeDeviceBootstrapProfile,
} from "../shared/device-bootstrap-profile.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { issueDeviceBootstrapToken } from "./device-bootstrap.js";
import {
  loadDeviceBootstrapTokenRecords,
  persistDeviceBootstrapTokenRecords,
} from "./device-pairing-store.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

it("keeps pending profiles readable across approval-link upgrades and rollbacks", async () => {
  const baseDir = await tempDirs.make("openclaw-bootstrap-codec-test-");
  const issued = await issueDeviceBootstrapToken({
    baseDir,
    profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  });
  const records = loadDeviceBootstrapTokenRecords(baseDir);
  const record = records[issued.token];
  if (!record) {
    throw new Error("expected issued bootstrap token");
  }
  records[issued.token] = {
    ...record,
    pendingProfile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    pendingApprovalRequests: [{ requestId: "request-1", role: "node", scopes: [] }],
  };
  persistDeviceBootstrapTokenRecords(records, baseDir);
  closeOpenClawStateDatabaseForTest();

  const reopened = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
  });
  const row = asRecord(
    reopened.db
      .prepare("SELECT pending_profile_json FROM device_bootstrap_tokens WHERE token_key = ?")
      .get(issued.token),
  );
  expect(normalizeDeviceBootstrapProfile(JSON.parse(String(row.pending_profile_json)))).toEqual(
    NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  );
  expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]).toMatchObject({
    pendingProfile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    pendingApprovalRequests: [{ requestId: "request-1", role: "node", scopes: [] }],
  });
});
