import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveMediaBuffer } from "../../media/store.js";
import { runNodeWorkerWorkspaceTransfer } from "../../node-host/node-worker-transfer-client.js";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import {
  buildPersistedUserTurnMessage,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { parseNodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  measureLaunchTurn,
  openSessionManager,
  placements,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";
import { parseWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { applyStagedWorkerWorkspace, readActualWorkspaceManifest } from "./workspace-reconcile.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

describe("current attachments in an active remote placement", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it.each(["worker-turn", "remote-exec"] as const)(
    "keeps later image and PDF originals readable with %s retention",
    async (executionMode) => {
      const remote = path.join(await realpath(root), "remote");
      const local = path.join(await realpath(root), "local");
      const remoteHome = path.join(await realpath(root), "remote-home");
      await Promise.all([mkdir(remote), mkdir(local), mkdir(remoteHome)]);
      for (const directory of [remote, local]) {
        await writeFile(path.join(directory, "remote-edits.txt"), "preserve me");
      }
      const base = await readActualWorkspaceManifest({ root: local, baseCommit: null });
      seedActivePlacement(executionMode, remote);
      // These arrive after placement: the initial workspace snapshot cannot include them.
      const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(220_000, 65)]);
      const image = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
        "base64",
      );
      const savedPdf = await saveMediaBuffer(
        pdf,
        "application/pdf",
        "inbound",
        pdf.length,
        "report.pdf",
      );
      const savedImage = await saveMediaBuffer(
        image,
        "image/png",
        "inbound",
        image.length,
        "photo.png",
      );
      const media = [
        { path: savedPdf.path, contentType: "application/pdf" },
        { path: savedImage.path, contentType: "image/png" },
      ];
      const recorder = createUserTurnTranscriptRecorder({
        message: buildPersistedUserTurnMessage({ text: "Read both attachments", media }),
        target: { ...sessionTarget, sessionEntry: { sessionId: SESSION_ID, updatedAt: 1 } },
      });
      const input = {
        ...turn(),
        workspaceDir: local,
        prompt: "Read both attachments",
        media: [media[0]!],
        userTurnTranscriptRecorder: recorder,
      };
      const originalFiles = new Map<string, Buffer>();
      const userFiles = [
        "openclaw-inbound-project/report.txt",
        "openclaw-inbound-12345678-1234-4234-8234-123456789ab-/report.txt",
      ];
      let workerManifestPaths: string[] = [];
      let acceptedManifestPaths: string[] = [];
      const verifyFiles = async (prompt: string) => {
        const files: Buffer[] = [];
        for (const entry of await readdir(remote, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile() || entry.name === "remote-edits.txt") {
            continue;
          }
          const file = path.join(entry.parentPath, entry.name);
          const bytes = await readFile(file);
          originalFiles.set(file, bytes);
          if (entry.name === ".gitignore") {
            continue;
          }
          files.push(bytes);
          expect(prompt).toContain(
            path.relative(remote, path.dirname(file)).split(path.sep).join("/"),
          );
        }
        expect(files).toHaveLength(2);
        expect(files.some((bytes) => bytes.equals(pdf))).toBe(true);
        expect(files.some((bytes) => bytes.equals(image))).toBe(true);
        expect(await readFile(path.join(remote, "remote-edits.txt"), "utf8")).toBe("preserve me");
        await writeFile(path.join(remote, "remote-edits.txt"), "worker edit");
        await writeFile(path.join(remote, "report.txt"), "Read both attachments");
        for (const file of userFiles) {
          await mkdir(path.dirname(path.join(remote, file)));
          await writeFile(path.join(remote, file), "user project output");
        }
      };
      const tunnel: WorkerTurnTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        runWorkspaceCommand: vi.fn(async (command) => {
          parseNodeWorkerWorkspaceExecInput(
            JSON.stringify({
              gatewayNamespace: "attachments",
              environmentId: ENVIRONMENT_ID,
              sessionId: SESSION_ID,
              generation: OWNER_EPOCH,
              argv: command.argv,
              input: command.input,
            }),
          );
          return await runCommandWithTimeout([...command.argv], {
            cwd: remote,
            input: command.input,
            timeoutMs: 10_000,
            signal: command.signal,
          });
        }),
        measureLaunchTurn,
        stageAttachments: async (request) => {
          const service = createNodeWorkspaceTransferService({
            getOwner: () => ({
              credential: {
                ownerEpoch: OWNER_EPOCH,
                sessionId: SESSION_ID,
                expiresAtMs: Date.now() + 60_000,
              },
              environment: attachedEnvironment(),
            }),
            temporaryRoot: path.join(remoteHome, "transfers"),
          });
          const server = await startNodeWorkspaceTransferTestServer(service);
          try {
            await service.prepareSync({
              environmentId: ENVIRONMENT_ID,
              ownerEpoch: OWNER_EPOCH,
              sessionId: SESSION_ID,
              generation: 1,
              localPath: local,
              isAuthorized: request.isAuthorized,
            });
            const prepared = await service.prepareAttachments({
              ...request,
              environmentId: ENVIRONMENT_ID,
            });
            await runNodeWorkerWorkspaceTransfer({
              gatewayUrl: server.gatewayUrl,
              environmentId: ENVIRONMENT_ID,
              workspaceDir: remote,
              manifestHome: remoteHome,
              transfer: {
                direction: "download",
                token: prepared.token,
                manifestRef: prepared.snapshot.manifestRef,
                attachments: true,
              },
              signal: request.signal,
            });
          } finally {
            await service.closeAll();
            await server.close();
          }
        },
        launchTurn: vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(
          async (request): Promise<SpawnResult> => {
            const prompt = request.plan.assignment.prompt;
            await verifyFiles(
              typeof prompt === "string"
                ? prompt
                : prompt.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
            );
            request.onDispatchReady?.();
            const transcriptLeafId = openSessionManager().appendMessage({
              role: "assistant",
              content: [{ type: "text", text: "Read both" }],
              api: "openai-responses",
              provider: "openai",
              model: "gpt-test",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            });
            createWorkerSessionPlacementGate(placements).updateAckCursors({
              claim: request.turnClaim,
              transcriptSeq: 2,
              liveSeq: 1,
            });
            return {
              stdout: JSON.stringify({
                status: "completed",
                transcriptLeafId,
                transcriptNextSeq: 3,
              }),
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
              termination: "exit",
            };
          },
        ),
        quiesceWorkspace: vi.fn(async () => ({
          assertActive: async () => {},
          resume: async () => {},
        })),
        reconcileWorkspace: vi.fn(async (request) => {
          const capture = await runCommandWithTimeout(
            [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, remote],
            { timeoutMs: 10_000, baseEnv: { ...process.env, HOME: remoteHome } },
          );
          expect(capture.code, capture.stderr).toBe(0);
          const manifestRef = capture.stdout.trim();
          const raw = await readFile(
            path.join(remoteHome, ".openclaw-worker", "manifests", `${manifestRef.slice(7)}.json`),
            "utf8",
          );
          const current = parseWorkerWorkspaceManifest(raw, manifestRef);
          const result = await applyStagedWorkerWorkspace({
            root: local,
            stagingRoot: remote,
            baseManifestRef: MANIFEST_REF,
            currentManifestRef: manifestRef,
            base: base.manifest,
            current,
            journal: request.journal,
          });
          workerManifestPaths = JSON.parse(raw).entries.map(
            (entry: { path: string }) => entry.path,
          );
          acceptedManifestPaths = result.manifest.entries.map((entry) => entry.path);
          return {
            ...result,
            changed: true,
            verifyStable: async () => {},
          };
        }),
        syncWorkspace: vi.fn(),
        stop: vi.fn(async () => {}),
      };
      const provider = createWorkerSessionTurnPlacementProvider({
        placements,
        resolveWorkspacePath: async () => local,
        environments: {
          ...unusedEnvironments(),
          get: () => attachedEnvironment(),
          acquireTurnCredential: async () => credential(),
          acknowledgeCredentialDelivery: () => true,
          startTunnel: async () => tunnel,
        },
      });
      await provider.executeTurn(
        { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: input.runId },
        input,
        async () => {
          await verifyFiles(input.prompt);
          return { meta: { durationMs: 1 } };
        },
      );
      if (executionMode === "remote-exec") {
        const commands = vi.mocked(tunnel.runWorkspaceCommand).mock.calls;
        expect(commands.at(-1)?.[0].input).toBe(JSON.stringify({ op: "discover" }));
        // At most one setup, three PDF chunks, and one image chunk.
        expect(commands.length - 1).toBeLessThanOrEqual(5);
      }
      expect(tunnel.syncWorkspace).not.toHaveBeenCalled();
      expect(tunnel.reconcileWorkspace).toHaveBeenCalledOnce();
      const retainedFiles =
        executionMode === "worker-turn"
          ? [...originalFiles.keys()].map((file) =>
              path.relative(remote, file).split(path.sep).join("/"),
            )
          : [];
      const expectedFiles = [
        "remote-edits.txt",
        "report.txt",
        ...userFiles,
        ...retainedFiles,
      ].toSorted();
      const expectedPaths = [
        ...new Set(
          expectedFiles.flatMap((file) => {
            const segments = file.split("/");
            return segments.map((_segment, index) => segments.slice(0, index + 1).join("/"));
          }),
        ),
      ].toSorted();
      expect(workerManifestPaths).toEqual(expectedPaths);
      expect(acceptedManifestPaths).toEqual(expectedFiles);
      expect(
        (await readdir(local, { recursive: true }))
          .map((entry) => entry.split(path.sep).join("/"))
          .toSorted(),
      ).toEqual(expectedPaths);
      expect(await readFile(path.join(local, "remote-edits.txt"), "utf8")).toBe("worker edit");
      expect(await readFile(path.join(local, "report.txt"), "utf8")).toBe("Read both attachments");
      for (const file of userFiles) {
        expect(await readFile(path.join(local, file), "utf8")).toBe("user project output");
      }
      for (const [file, bytes] of originalFiles) {
        expect(await readFile(file)).toEqual(bytes);
        if (executionMode === "worker-turn") {
          expect(await readFile(path.join(local, path.relative(remote, file)))).toEqual(bytes);
        }
      }
      expect(input.prompt).toBe("Read both attachments");
    },
  );
});
