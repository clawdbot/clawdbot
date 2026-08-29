import { afterEach, describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writeSessionStore } from "./test-helpers.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSelectedGlobalSessionStore } = setupGatewaySessionsHandlerTestHarness();

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

const mainRef = "main-provider/main-only";
const workRef = "work-provider/work-only";

type ModelSelectionCase = {
  label: string;
  explicitAgent?: boolean;
  globalAllow: string[];
  agentAllow?: string[];
  globalAlias?: string;
  agentAlias?: string;
  model: string;
  expectedModel: string;
  denied?: boolean;
};

function configureAgentModels(
  scenario: Pick<
    ModelSelectionCase,
    "globalAllow" | "agentAllow" | "globalAlias" | "agentAlias"
  > & { subagentModel?: string },
) {
  testState.agentConfig = {
    model: { primary: "synthetic/base" },
    modelPolicy: { allow: scenario.globalAllow },
    models: scenario.globalAlias ? { [workRef]: { alias: scenario.globalAlias } } : {},
  };
  testState.agentsConfig = {
    list: [
      {
        id: "main",
        default: true,
        modelPolicy: { allow: [mainRef] },
        models: { [mainRef]: { alias: "agent-choice" } },
      },
      {
        id: "work",
        subagents: scenario.subagentModel ? { model: scenario.subagentModel } : undefined,
        ...(scenario.agentAllow ? { modelPolicy: { allow: scenario.agentAllow } } : {}),
        models: scenario.agentAlias ? { [workRef]: { alias: scenario.agentAlias } } : {},
      },
    ],
  };
}

const cases: ModelSelectionCase[] = [
  {
    label: "loads the explicit agent model catalog",
    explicitAgent: true,
    globalAllow: [],
    model: workRef,
    expectedModel: workRef,
  },
  {
    label: "loads the agent-qualified session model catalog",
    globalAllow: [],
    model: workRef,
    expectedModel: workRef,
  },
  {
    label: "rejects outside agent policy despite unrestricted global policy",
    explicitAgent: true,
    globalAllow: [],
    agentAllow: [workRef],
    model: mainRef,
    expectedModel: mainRef,
    denied: true,
  },
  {
    label: "accepts an uncataloged model under explicit empty agent policy",
    globalAllow: [mainRef],
    agentAllow: [],
    model: "work-provider/uncataloged",
    expectedModel: "work-provider/uncataloged",
  },
  {
    label: "accepts the agent list instead of the opposing global list",
    explicitAgent: true,
    globalAllow: [mainRef],
    agentAllow: [workRef],
    model: workRef,
    expectedModel: workRef,
  },
  {
    label: "rejects the global list when the agent list replaces it",
    globalAllow: [mainRef],
    agentAllow: [workRef],
    model: mainRef,
    expectedModel: mainRef,
    denied: true,
  },
  {
    label: "resolves an agent-only alias under the target agent policy",
    globalAllow: [mainRef],
    agentAllow: [workRef],
    agentAlias: "agent-choice",
    model: "agent-choice",
    expectedModel: workRef,
  },
  {
    label: "uses the per-agent alias override for the same model key",
    explicitAgent: true,
    globalAllow: [mainRef],
    agentAllow: [workRef],
    globalAlias: "shared-choice",
    agentAlias: "agent-choice",
    model: "agent-choice",
    expectedModel: workRef,
  },
  {
    label: "rejects a displaced global alias",
    globalAllow: [workRef],
    agentAllow: [workRef],
    globalAlias: "shared-choice",
    agentAlias: "agent-choice",
    model: "shared-choice",
    expectedModel: "synthetic/shared-choice",
    denied: true,
  },
  {
    label: "checks the resolved agent alias against agent policy",
    globalAllow: [],
    agentAllow: [mainRef],
    agentAlias: "agent-choice",
    model: "agent-choice",
    expectedModel: workRef,
    denied: true,
  },
];

describe.each(["sessions.create", "sessions.patch"] as const)("%s", (method) => {
  test.each(cases)("$label", async (scenario) => {
    const { workStorePath } = await createSelectedGlobalSessionStore();
    configureAgentModels(scenario);
    const key = "agent:work:dashboard:catalog-owner";
    const access = { agentId: "work", sessionKey: key, storePath: workStorePath };
    if (method === "sessions.patch") {
      await writeSessionStore({
        agentId: "work",
        storePath: workStorePath,
        entries: {
          [key]: sessionStoreEntry("work-catalog-patch", {
            label: "Original label",
            providerOverride: "synthetic",
            modelOverride: "previous",
            modelOverrideSource: "user",
          }),
        },
      });
    }
    const before = loadSessionEntry(access);
    const loadGatewayModelCatalog = createAgentModelCatalogLoader();
    const result = await directSessionReq<{ entry?: SessionEntry }>(
      method,
      {
        key,
        ...(scenario.explicitAgent ? { agentId: "work" } : {}),
        model: scenario.model,
        label: "Updated label",
      },
      { context: { loadGatewayModelCatalog } },
    );

    expect(loadGatewayModelCatalog).toHaveBeenCalledWith({ agentId: "work" });
    if (scenario.denied) {
      expect.soft(result.ok).toBe(false);
      expect.soft(result.error).toMatchObject({
        code: "INVALID_REQUEST",
        message: `model not allowed: ${scenario.expectedModel}`,
      });
      expect(loadSessionEntry(access)).toEqual(before);
      return;
    }
    expect(result.ok, result.error?.message).toBe(true);
    const [providerOverride, modelOverride] = scenario.expectedModel.split("/");
    const selection = { providerOverride, modelOverride, modelOverrideSource: "user" };
    expect(result.payload?.entry).toMatchObject(selection);
    expect(loadSessionEntry(access)).toMatchObject({ ...selection, label: "Updated label" });
  });
});

test.each([
  { name: "pinned model requested by agent alias", subagent: false },
  { name: "configured subagent default alias requested by canonical model", subagent: true },
])("sessions.create preserves write-scoped adoption of $name", async ({ subagent }) => {
  const { workStorePath } = await createSelectedGlobalSessionStore();
  const otherRef = "work-provider/other";
  configureAgentModels({
    // The subagent request is globally allowed so only its default-alias comparison loses scope.
    globalAllow: subagent ? [workRef, otherRef] : [mainRef],
    agentAllow: [workRef, otherRef],
    agentAlias: "agent-choice",
    subagentModel: subagent ? "agent-choice" : undefined,
  });
  const key = `agent:work:${subagent ? "subagent" : "dashboard"}:adopt-selection`;
  const access = { agentId: "work", sessionKey: key, storePath: workStorePath };
  await writeSessionStore({
    agentId: "work",
    storePath: workStorePath,
    entries: {
      [key]: sessionStoreEntry("existing-selection", {
        label: "Original label",
        ...(subagent ? {} : { providerOverride: "work-provider", modelOverride: "work-only" }),
      }),
    },
  });
  const context = { loadGatewayModelCatalog: createAgentModelCatalogLoader() };
  const writeClient = { connect: { scopes: ["operator.write"] } } as never;
  const sameSelection = await directSessionReq<{ entry?: SessionEntry }>(
    "sessions.create",
    { key, model: subagent ? workRef : "agent-choice" },
    { client: writeClient, context },
  );

  expect(sameSelection.ok, sameSelection.error?.message).toBe(true);
  expect(loadSessionEntry(access)).toMatchObject({
    sessionId: "existing-selection",
    providerOverride: "work-provider",
    modelOverride: "work-only",
    modelOverrideSource: "user",
  });
  const beforeChange = loadSessionEntry(access);
  const denied = await directSessionReq(
    "sessions.create",
    { key, model: otherRef, label: "Must not change" },
    { client: writeClient, context },
  );
  expect(denied).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
  });
  expect(loadSessionEntry(access)).toEqual(beforeChange);

  const changed = await directSessionReq(
    "sessions.create",
    { key, model: otherRef },
    { client: { connect: { scopes: ["operator.admin"] } } as never, context },
  );
  expect(changed.ok, changed.error?.message).toBe(true);
  expect(loadSessionEntry(access)).toMatchObject({
    sessionId: "existing-selection",
    providerOverride: "work-provider",
    modelOverride: "other",
    modelOverrideSource: "user",
  });
});
