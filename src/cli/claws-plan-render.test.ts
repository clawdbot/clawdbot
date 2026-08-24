import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildClawAddPlan } from "../claws/lifecycle.js";
import { readClawManifestFile } from "../claws/reader.js";
import { packagePreflight } from "../claws/update-plan.test-helpers.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { renderClawAddPlanSummary } from "./claws-plan-render.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

describe("renderClawAddPlanSummary", () => {
  it("renders the consent-relevant surface of a full add plan", async () => {
    const result = await readClawManifestFile("src/claws/fixtures/incident-response.claw.json");
    if (!result.ok) {
      throw new Error(JSON.stringify(result.diagnostics));
    }
    const root = tempDirs.make("openclaw-claw-render-");
    const plan = await buildClawAddPlan({
      manifest: result.manifest,
      clawMarkdownBody: result.clawMarkdownBody,
      packageBootstrap: result.packageBootstrap,
      openClawProfile: result.openClawProfile,
      source: result.source,
      diagnostics: result.diagnostics,
      context: {
        workspace: `${root}/workspace-incident-response`,
        packagePreflight,
      },
    });
    const render = renderClawAddPlanSummary(plan);
    expect(render.errors).toEqual([]);
    expect(render.lines).toEqual([
      "Agent: incident-response",
      `Workspace: ${root}/workspace-incident-response`,
      "Actions: 8",
      "Packages: 2",
      "  Requirement clawhub:incident-triage@1.0.0: missing-installable (installation requires this exact plan consent)",
      "  Requirement clawhub:@openclaw/plugin-pager-duty@2.4.0: missing-installable (installation requires this exact plan consent)",
      "MCP servers: 1",
      "  MCP statuspage: npx --yes @acme/statuspage-mcp@1.0.0",
      "Cron jobs: 1",
      "Capability escalations (5):",
      '  ! agent:incident-response {"heartbeat":{"every":"30m","isolatedSession":true,"lightContext":true,"timeoutSeconds":120},"sandbox":{"mode":"all","scope":"agent","workspaceAccess":"rw"},"tools":{"allow":["read","write","web_fetch"],"deny":["exec","browser"]}}',
      '  ! cronJob:heartbeat-summary {"agentId":"incident-response","delivery":{"channel":"last","mode":"announce"},"id":"heartbeat-summary","message":"Review active incidents and prepare a concise status summary.","name":"Incident heartbeat summary","schedule":{"cron":"0 * * * *","timezone":"UTC"},"session":"isolated"}',
      '  ! mcpServer:statuspage {"args":["--yes","@acme/statuspage-mcp@1.0.0"],"command":"npx","env":["STATUSPAGE_TOKEN"]}',
      '  ! plugin:@openclaw/plugin-pager-duty {"installId":"@openclaw/plugin-pager-duty","integrity":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"plugin","ref":"@openclaw/plugin-pager-duty","source":"clawhub","version":"2.4.0"}',
      '  ! skill:incident-triage {"integrity":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"skill","ref":"incident-triage","source":"clawhub","version":"1.0.0"}',
      "The plan integrity binds every capability line above.",
    ]);
  });
});
