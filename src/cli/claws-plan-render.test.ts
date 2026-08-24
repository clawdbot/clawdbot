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
      '  ! agent:incident-response {"sandbox":{"mode":"all","scope":"agent","workspaceAccess":"rw"},"tools":{"allow":["read","write","web_fetch"],"deny":["exec","browser"]},"heartbeat":{"every":"30m","lightContext":true,"isolatedSession":true,"timeoutSeconds":120}}',
      '  ! cronJob:heartbeat-summary {"id":"heartbeat-summary","name":"Incident heartbeat summary","schedule":{"cron":"0 * * * *","timezone":"UTC"},"session":"isolated","message":"Review active incidents and prepare a concise status summary.","delivery":{"mode":"announce","channel":"last"},"agentId":"incident-response"}',
      '  ! mcpServer:statuspage {"command":"npx","args":["--yes","@acme/statuspage-mcp@1.0.0"],"env":["STATUSPAGE_TOKEN"]}',
      '  ! package:plugin:@openclaw/plugin-pager-duty {"kind":"plugin","source":"clawhub","ref":"@openclaw/plugin-pager-duty","version":"2.4.0","integrity":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","installId":"@openclaw/plugin-pager-duty"}',
      '  ! package:skill:incident-triage {"kind":"skill","source":"clawhub","ref":"incident-triage","version":"1.0.0","integrity":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
      "The plan integrity binds every capability line above.",
    ]);
  });
});
