import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  approvePairing,
  createChildEnv,
  startNodeProcess,
  stopChild,
  type CapturedChild,
} from "./gateway-node-mcp.test-support.js";
import {
  closeWireServer,
  connectWireClient,
  createPublishedWireWorkspace,
  type PublishedWireWorkspace,
} from "./paired-node-worker-wire-fixture.js";

const API_KEY = process.env.OPENAI_API_KEY?.trim();
const LIVE = process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(API_KEY);
const MODEL = "openai/gpt-5.6-luna";
const SKILL = "cleanup-live-proof";
const COMMAND = "codex.exec-server.stdio.v1";
const TIMEOUT_MS = 180_000;
const WAIT = { timeout: TIMEOUT_MS, interval: 50 };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type TurnResult = { status: string; error?: string };
type Placement = { state: string; remoteWorkspaceDir: string };
type SkillReceipt = {
  directory: string;
  workspace: string;
  ancestors: number[];
  bytes: number;
  digest: string;
  executable: boolean;
};

const HELPER = String.raw`
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const directory = fs.realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const workspace = path.dirname(path.dirname(directory));
const payload = fs.readFileSync(path.join(directory, "payload.txt"));
const ancestors = [];
for (let pid = process.pid; pid > 1;) {
  ancestors.push(pid);
  pid = Number(fs.readFileSync("/proc/" + pid + "/stat", "utf8").split(") ")[1].split(" ")[1]);
}
const mode = process.argv[2];
const receipt = { directory, workspace, ancestors, bytes: payload.length,
  digest: createHash("sha256").update(payload).digest("hex"),
  executable: Boolean(fs.statSync(fileURLToPath(import.meta.url)).mode & 0o111) };
fs.writeFileSync(path.join(workspace, "cleanup-ready-" + mode + ".json"), JSON.stringify(receipt));
if (mode === "held") {
  const deadline = Date.now() + 150000;
  while (!fs.existsSync(path.join(workspace, "cleanup-release"))) {
    if (Date.now() > deadline) throw Error("coordinator did not release helper");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
console.log("LIVE_SKILL_RESULT=" + JSON.stringify(receipt));
`;

// Linux /proc proves execution stayed beneath the real node process, not the Gateway.
describe.skipIf(!LIVE || process.platform !== "linux")("live worker skill resources", () => {
  it(
    "uses delivered skill paths and recovers failed cleanup before a no-skill turn",
    { timeout: 660_000 },
    async () => {
      const root = await fs.realpath(tempDirs.make("openclaw-worker-skill-live-"));
      const nodeHome = path.join(root, "node-home");
      const nodeState = path.join(root, "node-state");
      const nodeTmp = path.join(root, "node-tmp");
      const nodeConfigPath = path.join(root, "node.json");
      const skillsRoot = path.join(root, "skills");
      const skillDir = path.join(skillsRoot, SKILL);
      const hiddenSource = path.join(root, ".hidden-skill-source");
      const key = `agent:qa:worker-skill-live-${randomUUID()}`;
      const payload = Buffer.from("synthetic-cleanup-proof\n".repeat(7000));
      const files = [
        {
          name: "SKILL.md",
          bytes: Buffer.from(
            `---\nname: ${SKILL}\ndescription: Run a synthetic worker skill resource probe.\n---\nRead these instructions in full. Run node scripts/report.mjs relative to this SKILL.md, passing normal or held as requested. The held probe waits for its coordinator; wait for completion without releasing or interrupting it. Report LIVE_SKILL_RESULT from the actual output. Do not edit or clean up files.\n`,
          ),
          executable: false,
        },
        { name: "payload.txt", bytes: payload, executable: false },
        { name: "scripts/report.mjs", bytes: Buffer.from(HELPER), executable: true },
      ];
      const owner = createQaGatewayChild();
      let node: CapturedChild | undefined;
      let client: GatewayClient | undefined;
      let published: PublishedWireWorkspace | undefined;
      let gatewayToken: string | undefined;
      await runQaGatewayFixture(
        async () => {
          try {
            await Promise.all(
              [nodeHome, nodeState, nodeTmp, path.join(skillDir, "scripts")].map((dir) =>
                fs.mkdir(dir, { recursive: true }),
              ),
            );
            for (const file of files) {
              await fs.writeFile(path.join(skillDir, file.name), file.bytes, {
                mode: file.executable ? 0o755 : 0o600,
              });
            }
            published = await createPublishedWireWorkspace(path.join(root, "project"));
            const gateway = await owner.start({
              repoRoot: process.cwd(),
              command: {
                executablePath: process.execPath,
                argsPrefix: ["dist/index.js"],
                cwd: process.cwd(),
                usePackagedPlugins: true,
              },
              transportBaseUrl: "http://127.0.0.1",
              providerMode: "live-frontier",
              primaryModel: MODEL,
              alternateModel: MODEL,
              forcedRuntime: "codex",
              enabledPluginIds: ["codex"],
              controlUiEnabled: false,
              runtimeEnvPatch: { OPENAI_API_KEY: API_KEY, OPENCLAW_SKIP_CHANNELS: "1" },
              mutateConfig: (cfg) => ({
                ...cfg,
                skills: {
                  ...cfg.skills,
                  allowBundled: [],
                  load: { extraDirs: [skillsRoot], watch: false },
                },
                agents: {
                  ...cfg.agents,
                  defaults: {
                    ...cfg.agents?.defaults,
                    timeoutSeconds: 150,
                    skills: [SKILL],
                    models: { [MODEL]: { agentRuntime: { id: "codex" } } },
                  },
                  entries: {
                    ...cfg.agents?.entries,
                    qa: {
                      ...cfg.agents?.entries?.qa,
                      skills: [SKILL],
                      model: { primary: MODEL },
                      tools: { profile: "full" },
                    },
                  },
                },
                tools: { ...cfg.tools, profile: "full", toolSearch: false, codeMode: false },
                memory: { search: { enabled: false } },
                plugins: {
                  ...cfg.plugins,
                  slots: { ...cfg.plugins?.slots, memory: "none" },
                  entries: { ...cfg.plugins?.entries, "memory-core": { enabled: false } },
                },
                gateway: {
                  ...cfg.gateway,
                  nodes: {
                    ...cfg.gateway?.nodes,
                    commands: { allow: [COMMAND] },
                    pairing: {
                      ...cfg.gateway?.nodes?.pairing,
                      autoApproveLocal: false,
                      sshVerify: false,
                    },
                  },
                },
                nodeHost: { ...cfg.nodeHost, workerRuns: { enabled: true } },
              }),
            });
            gatewayToken = gateway.token;
            const operator = await connectWireClient({ gateway, role: "operator", identity: null });
            client = operator;
            await fs.writeFile(
              nodeConfigPath,
              JSON.stringify({
                gateway: { mode: "local" },
                plugins: { allow: ["codex"], entries: { codex: { enabled: true } } },
                nodeHost: { workerRuns: { enabled: true }, skills: { enabled: false } },
              }),
              { mode: 0o600 },
            );
            const nodeEnv = createChildEnv({
              home: nodeHome,
              tempDir: nodeTmp,
              extra: {
                OPENCLAW_HOME: nodeHome,
                OPENCLAW_STATE_DIR: nodeState,
                OPENCLAW_CONFIG_PATH: nodeConfigPath,
                OPENCLAW_GATEWAY_TOKEN: gateway.token,
                OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
              },
            });
            expect(nodeEnv.OPENAI_API_KEY).toBeUndefined();
            const port = Number(new URL(gateway.baseUrl).port);
            node = startNodeProcess(port, nodeEnv);
            const nodeId = await approvePairing(gateway, "device");
            await stopChild(node);
            node = startNodeProcess(port, nodeEnv);
            await approvePairing(gateway, "node", nodeId);
            const nodePid = node.child.pid;
            expect(nodePid).toBeGreaterThan(0);
            await vi.waitFor(async () => {
              const inventory = await operator.request<{
                nodes: Array<{
                  nodeId: string;
                  connected: boolean;
                  approvalState: string;
                  commands: string[];
                }>;
              }>("node.list", {});
              const connected = inventory.nodes.find((entry) => entry.nodeId === nodeId);
              expect(connected).toMatchObject({
                connected: true,
                approvalState: "approved",
                sessionHost: true,
              });
              expect(connected?.commands).toContain(COMMAND);
            }, WAIT);
            await operator.request("sessions.create", {
              key,
              agentId: "qa",
              model: MODEL,
              permissionMode: "full",
              worktree: true,
              worktreeName: "worker-skill-live",
              worktreeBaseRef: "main",
              cwd: published.source,
            });
            const { placement } = await operator.request<{ placement: Placement }>(
              "sessions.dispatch",
              { key, deviceId: nodeId },
              { timeoutMs: TIMEOUT_MS },
            );
            expect(placement.state).toBe("active");
            const remote = placement.remoteWorkspaceDir;
            const start = async (message: string) => {
              const runId = randomUUID();
              expect(
                await operator.request("chat.send", {
                  sessionKey: key,
                  message,
                  deliver: false,
                  idempotencyKey: runId,
                }),
              ).toMatchObject({ runId, status: "started" });
              return runId;
            };
            const wait = (runId: string) =>
              operator.request<TurnResult>(
                "agent.wait",
                { runId, timeoutMs: TIMEOUT_MS },
                { timeoutMs: TIMEOUT_MS + 5000 },
              );
            const skillTurn = async (
              mode: "normal" | "held",
              instruction: string,
              finish: (receipt: SkillReceipt, runId: string) => Promise<void>,
            ) => {
              const runId = await start(instruction);
              await vi.waitFor(async () => {
                const allocations = (await fs.readdir(remote)).filter((name) =>
                  name.startsWith("openclaw-inbound-"),
                );
                expect(allocations).toHaveLength(1);
                const copied = path.join(remote, allocations[0]!, "0");
                for (const file of files) {
                  expect(await fs.readFile(path.join(copied, file.name))).toEqual(file.bytes);
                  expect((await fs.stat(path.join(copied, file.name))).mode & 0o777).toBe(
                    file.executable ? 0o500 : 0o400,
                  );
                }
              }, WAIT);
              // Hide only after copying finishes; a colocated node must not succeed using Gateway files.
              await fs.rename(skillDir, hiddenSource);
              try {
                const receipt: SkillReceipt = await vi.waitFor(
                  async () =>
                    JSON.parse(
                      await fs.readFile(path.join(remote, `cleanup-ready-${mode}.json`), "utf8"),
                    ),
                  WAIT,
                );
                expect(receipt).toMatchObject({
                  workspace: remote,
                  bytes: payload.length,
                  digest: createHash("sha256").update(payload).digest("hex"),
                  executable: true,
                });
                expect(receipt.directory).toMatch(/\/openclaw-inbound-[0-9a-f-]+\/0$/u);
                expect(receipt.ancestors).toContain(nodePid);
                expect(receipt.ancestors).not.toContain(gateway.pid);
                await finish(receipt, runId);
                console.info(
                  JSON.stringify({ proof: "worker-skill-resources", model: MODEL, mode, receipt }),
                );
              } finally {
                await fs.rename(hiddenSource, skillDir);
              }
            };
            await skillTurn(
              "normal",
              `Use the ${SKILL} skill to run its normal probe and report the result.`,
              async (receipt, runId) => {
                expect(await wait(runId)).toMatchObject({ status: "ok" });
                await expect(fs.stat(path.dirname(receipt.directory))).rejects.toMatchObject({
                  code: "ENOENT",
                });
              },
            );
            const abandoned = path.join(remote, `openclaw-inbound-${randomUUID()}`);
            await skillTurn(
              "held",
              `$${SKILL} Run the held probe and report the result.`,
              async (receipt, runId) => {
                // A moved real allocation leaves cleanup's captured path unavailable without replacing its implementation.
                await fs.rename(path.dirname(receipt.directory), abandoned);
                await fs.writeFile(path.join(remote, "cleanup-release"), "release\n");
                const failed = await wait(runId);
                expect(failed).toMatchObject({ status: "error" });
                expect(failed.error).toMatch(/cleanup/iu);
                expect(await fs.readFile(path.join(abandoned, ".gitignore"), "utf8")).toBe("*\n");
                expect(await fs.readFile(path.join(abandoned, "0/payload.txt"))).toEqual(payload);
              },
            );
            const attachment = path.join(remote, `openclaw-inbound-${randomUUID()}`);
            const projectFile = path.join(remote, "project-sentinel.txt");
            await fs.mkdir(attachment);
            await fs.writeFile(path.join(attachment, "attachment.txt"), "attachment survives\n");
            await fs.writeFile(projectFile, "project survives\n");
            await operator.request("sessions.patch", {
              key,
              toolOverrides: { skills: { [SKILL]: false } },
            });
            const probe = `node -e 'const fs=require("node:fs");const result={cwd:process.cwd(),directories:fs.readdirSync(".").filter(n=>n.startsWith("openclaw-inbound-"))};fs.writeFileSync("cleanup-no-skills.json",JSON.stringify(result));console.log(JSON.stringify(result))'`;
            const recovery = await start(
              `Do not use skills. In the session workspace, execute this exact command: ${probe}. Report the actual output without changing or deleting other files.`,
            );
            expect(await wait(recovery)).toMatchObject({ status: "ok" });
            const observed: { cwd: string; directories: string[] } = JSON.parse(
              await fs.readFile(path.join(remote, "cleanup-no-skills.json"), "utf8"),
            );
            expect(observed).toEqual({ cwd: remote, directories: [path.basename(attachment)] });
            await expect(fs.stat(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
            expect(await fs.readFile(path.join(attachment, "attachment.txt"), "utf8")).toBe(
              "attachment survives\n",
            );
            expect(await fs.readFile(projectFile, "utf8")).toBe("project survives\n");
            const current = await operator.request<{ session: { placement: Placement } }>(
              "sessions.describe",
              { key },
            );
            expect(current.session.placement.remoteWorkspaceDir).toBe(remote);
            console.info(
              JSON.stringify({
                proof: "worker-skill-resources",
                model: MODEL,
                recovery: observed,
                abandonedRemoved: true,
                attachmentPreserved: true,
                projectPreserved: true,
              }),
            );
          } catch (error) {
            if (client) {
              const history = await client
                .request("chat.history", { sessionKey: key, limit: 100 })
                .catch(() => undefined);
              if (history) {
                let diagnostic = JSON.stringify(history);
                for (const secret of [API_KEY, gatewayToken]) {
                  if (secret) {
                    diagnostic = diagnostic.replaceAll(secret, "[REDACTED]");
                  }
                }
                console.info(`worker-skill-resources history: ${diagnostic.slice(-16000)}`);
              }
            }
            throw error;
          }
        },
        () => client?.stopAndWait(),
        () => stopChild(node),
        () => stopQaGatewayFixture(owner),
        () => published && closeWireServer(published.server),
      );
    },
  );
});
