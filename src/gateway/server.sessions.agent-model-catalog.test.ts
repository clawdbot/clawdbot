import { afterEach, expect, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSelectedGlobalSessionStore } = setupGatewaySessionsTestHarness();

const mainModel = { id: "main-only", name: "Main Model", provider: "main-provider" };
const workModel = { id: "work-only", name: "Work Model", provider: "work-provider" };

function createAgentModelCatalogLoader() {
  return vi.fn(async (params?: { agentId?: string }) =>
    params?.agentId === "work" ? [workModel] : [mainModel],
  );
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test.each([
  { label: "explicit agent", agentId: "work" },
  { label: "agent-qualified session", agentId: undefined },
])("sessions.patch loads the $label model catalog", async ({ agentId }) => {
  const { workStorePath } = await createSelectedGlobalSessionStore();
  const key = "agent:work:dashboard:catalog-owner-patch";
  await writeSessionStore({
    agentId: "work",
    storePath: workStorePath,
    entries: { [key]: sessionStoreEntry("work-catalog-patch") },
  });
  const loadGatewayModelCatalog = createAgentModelCatalogLoader();

  const patched = await directSessionReq<{
    entry?: { modelOverride?: string; providerOverride?: string };
  }>(
    "sessions.patch",
    {
      key,
      ...(agentId ? { agentId } : {}),
      model: "work-provider/work-only",
    },
    { context: { loadGatewayModelCatalog } },
  );

  expect(patched.ok, patched.error?.message).toBe(true);
  expect(loadGatewayModelCatalog).toHaveBeenCalledWith({ agentId: "work" });
  expect(patched.payload?.entry).toMatchObject({
    providerOverride: "work-provider",
    modelOverride: "work-only",
  });
  expect(
    loadSessionEntry({ agentId: "work", sessionKey: key, storePath: workStorePath }),
  ).toMatchObject({
    providerOverride: "work-provider",
    modelOverride: "work-only",
  });
});

test.each([
  { label: "explicit agent", agentId: "work" },
  { label: "agent-qualified session", agentId: undefined },
])("sessions.create loads the $label model catalog", async ({ agentId }) => {
  const { workStorePath } = await createSelectedGlobalSessionStore();
  const key = `agent:work:dashboard:catalog-owner-create-${agentId ? "explicit" : "key"}`;
  const loadGatewayModelCatalog = createAgentModelCatalogLoader();

  const created = await directSessionReq<{
    entry?: { modelOverride?: string; providerOverride?: string };
  }>(
    "sessions.create",
    {
      key,
      ...(agentId ? { agentId } : {}),
      model: "work-provider/work-only",
    },
    { context: { loadGatewayModelCatalog } },
  );

  expect(created.ok, created.error?.message).toBe(true);
  expect(loadGatewayModelCatalog).toHaveBeenCalledWith({ agentId: "work" });
  expect(created.payload?.entry).toMatchObject({
    providerOverride: "work-provider",
    modelOverride: "work-only",
  });
  expect(
    loadSessionEntry({ agentId: "work", sessionKey: key, storePath: workStorePath }),
  ).toMatchObject({
    providerOverride: "work-provider",
    modelOverride: "work-only",
  });
});
