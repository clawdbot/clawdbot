import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const TEST_TIMEOUT_MS = 30_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

async function setupTempHome() {
  const env = captureEnv([...ENV_KEYS]);
  const home = tempDirs.make("openclaw-skill-proposal-proof-");
  const stateDir = path.join(home, ".openclaw");
  const workspace = path.join(home, "workspace");
  const bundledPlugins = path.join(home, "empty-bundled-plugins");
  await Promise.all([
    fs.mkdir(stateDir, { recursive: true }),
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(bundledPlugins, { recursive: true }),
  ]);
  setTestEnvValue("HOME", home);
  setTestEnvValue("USERPROFILE", home);
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
  setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
  setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
  setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
  setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
  setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
  setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledPlugins);
  setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  return {
    configPath: path.join(stateDir, "openclaw.json"),
    env,
    workspace,
  };
}

type ProposalRecord = {
  id: string;
  kind: "create";
  status: string;
  statusReason?: string;
  staleAt?: string;
  target: {
    skillKey: string;
    skillFile: string;
  };
};

describe("Skill proposal manual-target product proof", () => {
  it(
    "persists stale state and rejects apply after a target is installed manually",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const temp = await setupTempHome();
      const token = `skill-proposal-proof-${process.pid}`;
      let started: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

      try {
        started = await startGatewayWithClient({
          cfg: {
            agents: { defaults: { workspace: temp.workspace } },
            gateway: { auth: { mode: "token", token } },
          },
          configPath: temp.configPath,
          token,
          clientDisplayName: "skill-proposal-manual-target-proof",
        });

        const created = (await started.client.request("skills.proposals.create", {
          agentId: "main",
          name: "Manual Gateway Proof",
          description: "Proof for a manually installed proposal target.",
          content: "# Manual Gateway Proof\n\nProposal draft.\n",
        })) as { record: ProposalRecord };
        expect(created.record).toMatchObject({
          kind: "create",
          status: "pending",
          target: {
            skillKey: "manual-gateway-proof",
            skillFile: path.join(temp.workspace, "skills", "manual-gateway-proof", "SKILL.md"),
          },
        });

        await fs.mkdir(path.dirname(created.record.target.skillFile), { recursive: true });
        await fs.writeFile(
          created.record.target.skillFile,
          "# Manual Gateway Proof\n\nInstalled manually.\n",
          "utf8",
        );

        const listed = (await started.client.request("skills.proposals.list", {
          agentId: "main",
        })) as { proposals: ProposalRecord[] };
        const listedRecord = listed.proposals.find((proposal) => proposal.id === created.record.id);
        expect(listedRecord).toMatchObject({ kind: "create", status: "stale" });

        const inspected = (await started.client.request("skills.proposals.inspect", {
          agentId: "main",
          proposalId: created.record.id,
        })) as { record: ProposalRecord; revisionHash: string };
        expect(inspected.record).toMatchObject({
          id: created.record.id,
          status: "stale",
          statusReason: "Target skill was created after proposal creation.",
          staleAt: expect.any(String),
        });

        const events = (await started.client.request("skills.proposals.events.list", {
          agentId: "main",
          proposalId: created.record.id,
        })) as {
          events: Array<{
            actor: { type: string };
            proposalId: string;
            type: string;
          }>;
        };
        expect(events.events.map((event) => event.type)).toEqual(["created", "stale"]);
        expect(events.events.at(-1)).toMatchObject({
          actor: { type: "system" },
          proposalId: created.record.id,
          type: "stale",
        });

        let applyError: unknown;
        try {
          await started.client.request("skills.proposals.apply", {
            agentId: "main",
            proposalId: created.record.id,
            expectedRevisionHash: inspected.revisionHash,
          });
        } catch (error) {
          applyError = error;
        }
        expect(applyError).toMatchObject({
          gatewayCode: "INVALID_REQUEST",
          message: "Only pending proposals can be applied. Current status: stale.",
        });

        console.info(
          `[skill-proposal-manual-target-proof] ${JSON.stringify({
            head: process.env.OPENCLAW_PROOF_HEAD ?? "not-specified",
            transport: "loopback-token-auth-websocket",
            workspaceIsolated: true,
            createdStatus: created.record.status,
            listStatus: listedRecord?.status,
            inspectStatus: inspected.record.status,
            statusReason: inspected.record.statusReason,
            durableEvents: events.events.map((event) => event.type),
            staleActor: events.events.at(-1)?.actor.type,
            applyRejected: applyError !== undefined,
            applyErrorCode:
              applyError && typeof applyError === "object" && "gatewayCode" in applyError
                ? applyError.gatewayCode
                : undefined,
            verdict: "PASS",
          })}`,
        );
      } finally {
        try {
          if (started) {
            await disconnectGatewayClient(started.client).catch(() => undefined);
            await started.server.close({ reason: "Skill proposal proof complete" });
          }
        } finally {
          temp.env.restore();
        }
      }
    },
  );
});
