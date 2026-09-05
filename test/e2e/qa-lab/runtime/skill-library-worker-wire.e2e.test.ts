import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { buildQaGatewayConfig } from "../../../../extensions/qa-lab/api.js";
import type {
  SkillsLibraryActivateResult,
  SkillsLibraryListResult,
  SkillsLibraryReceipt,
  SkillsLibraryReadResult,
} from "../../../../packages/gateway-protocol/src/schema/skill-library.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { MODEL_REF, PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import {
  closeWireServer,
  createPublishedWireWorkspace,
  wireMessageText,
  type PublishedWireWorkspace,
} from "./paired-node-worker-wire-fixture.js";
import { startSkillLibraryNodeProcess } from "./skill-library-node-process.js";
import {
  createSkillLibraryWireInstance,
  decodedSkillLibraryFiles,
  SKILL_LIBRARY_ALICE,
  SKILL_LIBRARY_BOB,
  SkillLibraryWireClient,
} from "./skill-library-wire-fixture.js";
import {
  executableSkillLibraryBundle,
  startSkillLibraryWireProvider,
  type SkillLibraryTurnObservation,
} from "./skill-library-wire-provider.js";

const execFileAsync = promisify(execFile);

async function workspaceStatus(directory: string) {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", directory, "status", "--porcelain", "--untracked-files=all", "--ignored"],
    { timeout: 20_000 },
  );
  return stdout;
}

function executionOutput(observation: SkillLibraryTurnObservation | undefined) {
  expect(observation?.readOutput).toContain("Run scripts/report.mjs relative to this SKILL.md.");
  const line = observation?.execOutput?.match(/SKILL_LIBRARY_OUTPUT=(\{[^\n]*\})/u)?.[1];
  if (!line) {
    throw new Error(
      `Bundled helper returned no JSON result: ${observation?.execOutput ?? "no tool output"}`,
    );
  }
  return JSON.parse(line) as {
    skill: string;
    reference: string;
    binary: string;
    executable: boolean;
    directory: string;
    helper: string;
  };
}

function outside(directory: string, other: string) {
  const relative = path.relative(other, directory);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

describe("skill library mock-provider E2E through real Gateway and node worker", () => {
  it(
    "pins the creator's bundle across ordinary collaborator authoring, edits, turn boundaries, removal and worker replacement",
    { timeout: 600_000 },
    async () => {
      const instance = await createSkillLibraryWireInstance();
      let provider: Awaited<ReturnType<typeof startSkillLibraryWireProvider>> | undefined;
      let node: Awaited<ReturnType<typeof startSkillLibraryNodeProcess>> | undefined;
      let published: PublishedWireWorkspace | undefined;
      const clients: SkillLibraryWireClient[] = [];
      await runQaGatewayFixture(
        async () => {
          provider = await startSkillLibraryWireProvider();
          published = await createPublishedWireWorkspace(instance.state.root);
          const authConfig = JSON.parse(
            await fs.readFile(instance.configPath, "utf8"),
          ) as OpenClawConfig;
          const config = buildQaGatewayConfig({
            bind: "loopback",
            gatewayPort: instance.port,
            gatewayToken: instance.gatewayToken,
            workspaceDir: instance.state.workspaceDir,
            providerBaseUrl: `${provider.baseUrl}/v1`,
            providerMode: "mock-openai",
            primaryModel: MODEL_REF,
            alternateModel: MODEL_REF,
            controlUiEnabled: false,
            enabledPluginIds: ["openai"],
          });
          await instance.state.writeConfig({
            ...config,
            gateway: authConfig.gateway,
            tools: { ...config.tools, codeMode: false, exec: { mode: "full" } },
            nodeHost: { workerRuns: { enabled: true } },
          });
          console.info("[skill-library-wire] starting isolated Gateway");
          await instance.startGateway();
          console.info("[skill-library-wire] Gateway ready; authenticating users");
          const connect = async (
            options?: Parameters<typeof SkillLibraryWireClient.connect>[1],
          ) => {
            const connected = await SkillLibraryWireClient.connect(instance, options);
            clients.push(connected.client);
            return connected;
          };
          const { client: admin, hello } = await connect();
          const { client: aliceAdmin } = await connect({
            email: SKILL_LIBRARY_ALICE,
            scopes: ["operator.admin", "operator.read", "operator.write"],
            buildId: hello.server.buildId,
          });
          const { client: alice } = await connect({
            email: SKILL_LIBRARY_ALICE,
            buildId: hello.server.buildId,
          });
          const { client: bob } = await connect({
            email: SKILL_LIBRARY_BOB,
            buildId: hello.server.buildId,
          });
          const original = executableSkillLibraryBundle();
          console.info("[skill-library-wire] publishing Alice/Bob private bundles");
          const saved = await alice.request<SkillsLibraryReceipt>("skills.library.save", original);
          const bobSaved = await bob.request<SkillsLibraryReceipt>(
            "skills.library.save",
            executableSkillLibraryBundle("BOB-PRIVATE-RESOURCE\n"),
          );
          const createSession = async (suffix: string) => {
            const key = `agent:qa:skill-library-${suffix}`;
            await aliceAdmin.request("sessions.create", {
              key,
              agentId: "qa",
              visibility: "shared",
              permissionMode: "full",
              worktree: true,
              worktreeName: `skill-library-${suffix}`,
              worktreeBaseRef: "main",
              cwd: published!.source,
            });
            return key;
          };
          const localKey = await createSession("local");
          const remoteKey = await createSession("worker");
          console.info("[skill-library-wire] shared managed sessions created");
          const startTurn = async (
            client: SkillLibraryWireClient,
            key: string,
            marker: string,
            name?: string,
          ) => {
            const runId = `skill-library-${marker}`;
            console.info(`[skill-library-wire] starting turn ${marker}`);
            await expect(
              client.request("chat.send", {
                sessionKey: key,
                message: `SKILL-LIBRARY-PROBE:${marker}${name ? ` name=${name}` : ""}`,
                deliver: false,
                idempotencyKey: runId,
              }),
            ).resolves.toMatchObject({ runId, status: "started" });
            return runId;
          };
          const finishTurn = async (
            client: SkillLibraryWireClient,
            key: string,
            marker: string,
            runId: string,
          ) => {
            await expect(
              client.request(
                "agent.wait",
                { runId, timeoutMs: PROOF_TIMEOUT_MS },
                PROOF_TIMEOUT_MS + 5_000,
              ),
            ).resolves.toMatchObject({ status: "ok" });
            await vi.waitFor(
              async () => {
                const history = await client.request<{ messages: unknown[] }>("chat.history", {
                  sessionKey: key,
                  limit: 100,
                });
                expect(
                  history.messages.some(
                    (message) =>
                      (message as { role?: string }).role === "assistant" &&
                      wireMessageText(message).includes(`TOOL-RESULT:${marker}`),
                  ),
                ).toBe(true);
              },
              { timeout: 30_000, interval: 100 },
            );
            expect(provider!.errors).toEqual([]);
            const observation = provider!.observations.get(marker);
            expect(observation?.catalogs.length).toBeGreaterThan(0);
            for (const catalog of observation!.catalogs) {
              expect(catalog.map((skill) => skill.name)).toContain(saved.entry.name);
              expect(catalog.map((skill) => skill.name)).not.toContain(bobSaved.entry.name);
            }
            const result = executionOutput(observation);
            console.info(`[skill-library-wire] verified turn ${marker}`);
            return result;
          };
          const turn = async (client: SkillLibraryWireClient, key: string, marker: string) =>
            finishTurn(client, key, marker, await startTurn(client, key, marker, saved.entry.name));
          const describeSession = (key: string) =>
            admin.request<{ session: { execCwd?: string; spawnedCwd?: string } }>(
              "sessions.describe",
              { key },
            );
          const localDescription = await describeSession(localKey);
          const remoteDescription = await describeSession(remoteKey);
          const localCwd = localDescription.session.execCwd ?? localDescription.session.spawnedCwd;
          const gatewayWorkerCwd =
            remoteDescription.session.execCwd ?? remoteDescription.session.spawnedCwd;
          if (!localCwd || !gatewayWorkerCwd) {
            throw new Error("Managed sessions did not expose their workspace directories");
          }
          const localBefore = await workspaceStatus(localCwd);
          const workerBefore = await workspaceStatus(gatewayWorkerCwd);

          const localFirst = await turn(alice, localKey, "local-first");
          expect(localFirst).toMatchObject({
            skill: original.content,
            reference: "ALICE-RESOURCE-1\n",
            binary: "000102ff",
            executable: true,
            helper: "bundled-helper-v1",
          });
          expect(outside(localFirst.directory, localCwd)).toBe(true);
          console.info("[skill-library-wire] pairing real node");
          node = await startSkillLibraryNodeProcess(instance, admin);
          console.info("[skill-library-wire] dispatching managed session to node");
          const dispatched = await admin.request<{
            placement: { state: string; remoteWorkspaceDir: string; workerBundleHash: string };
          }>("sessions.dispatch", { key: remoteKey, deviceId: node.nodeId }, PROOF_TIMEOUT_MS);
          expect(dispatched.placement.state).toBe("active");
          console.info("[skill-library-wire] node placement active");
          expect(dispatched.placement.workerBundleHash).toMatch(/^[a-f0-9]{64}$/u);
          const remoteCwd = await fs.realpath(dispatched.placement.remoteWorkspaceDir);
          const commandCatalog = async (client: SkillLibraryWireClient) => {
            const result = await client.request<{
              commands: Array<{ source: string; name: string }>;
            }>("commands.list", { agentId: "qa", sessionKey: remoteKey });
            return result.commands.filter((command) => command.source === "skill");
          };
          const aliceCommands = await commandCatalog(alice);
          expect(aliceCommands).toContainEqual(expect.objectContaining({ name: saved.entry.name }));
          expect(await commandCatalog(bob)).toEqual(aliceCommands);
          const sessionLibrary = (client: SkillLibraryWireClient) =>
            client.request<SkillsLibraryListResult>("skills.library.list", {
              sessionKey: remoteKey,
            });
          const beforeAuthoring = await sessionLibrary(alice);
          expect(beforeAuthoring.session).toMatchObject({
            sessionKey: remoteKey,
            selections: [
              {
                skillId: saved.entry.skillId,
                revision: saved.entry.revision,
                name: saved.entry.name,
                ownerProfileId: saved.entry.ownerProfileId,
                ownerLabel: saved.entry.ownerLabel,
              },
            ],
          });
          const bobSessionLibrary = await sessionLibrary(bob);
          expect(bobSessionLibrary.session?.selections).toEqual(
            beforeAuthoring.session!.selections,
          );
          expect(bobSessionLibrary.entries.map((entry) => entry.skillId)).not.toContain(
            saved.entry.skillId,
          );
          expect(bobSessionLibrary.session?.attachable.map((entry) => entry.skillId)).toEqual([
            bobSaved.entry.skillId,
          ]);
          const readPin = (revision: string) =>
            bob.request<SkillsLibraryReadResult>("skills.library.read", {
              sessionKey: remoteKey,
              skillId: saved.entry.skillId,
              revision,
            });
          // Session membership grants the exact pin's bytes, not access to Alice's private history.
          const pinnedRead = await readPin(saved.entry.revision);
          expect(pinnedRead.entry).toMatchObject({
            revision: saved.entry.revision,
            canEdit: false,
          });
          expect(pinnedRead.content).toBe(original.content);
          expect(decodedSkillLibraryFiles(pinnedRead.files)).toEqual(
            decodedSkillLibraryFiles(original.files!),
          );
          expect(pinnedRead.revisions.map((entry) => entry.revision)).toEqual([
            saved.entry.revision,
          ]);
          await expect(
            bob.request("skills.library.read", {
              skillId: saved.entry.skillId,
              revision: saved.entry.revision,
            }),
          ).rejects.toMatchObject({ error: { details: { code: "SKILL_LIBRARY_NOT_FOUND" } } });
          await expect(
            bob.request("skills.library.mutate", {
              skillId: saved.entry.skillId,
              expectedRevision: saved.entry.revision,
              action: "remove",
            }),
          ).rejects.toMatchObject({ error: { details: { code: "SKILL_LIBRARY_NOT_FOUND" } } });
          await bob.request("chat.history", { sessionKey: remoteKey, limit: 20 });
          const workerFirst = await turn(bob, remoteKey, "bob-worker-first");
          expect({ ...workerFirst, directory: undefined }).toEqual({
            ...localFirst,
            directory: undefined,
          });
          // A process on this host can see Gateway files. Require a distinct node-owned materialization,
          // otherwise the test could pass by accidentally reading the Gateway's original bundle.
          const workerSkillDir = workerFirst.directory;
          expect(outside(workerSkillDir, await fs.realpath(instance.stateDir))).toBe(true);
          expect(outside(workerSkillDir, remoteCwd)).toBe(true);
          expect(outside(workerSkillDir, await fs.realpath(node.stateDir))).toBe(false);
          expect(workerSkillDir).not.toBe(await fs.realpath(localFirst.directory));

          // Authoring belongs to the authenticated invoker, even when the session pins Alice's A.
          // Ordinary chat admission owns authority; the model supplies content and the read revision.
          const draft = {
            ...executableSkillLibraryBundle("BOB-WORKER-AUTHORED\n"),
            slug: "worker-authored",
          };
          const authoredContent =
            draft.content + "Keep all existing supporting files for future reuse.\n";
          provider.authorDraft("bob-worker", draft, authoredContent);
          const authorRunId = "skill-library-bob-author";
          console.info("[skill-library-wire] Bob ordinary-chat create/read/update");
          await expect(
            bob.request("chat.send", {
              sessionKey: remoteKey,
              message:
                "Create a private skill in my library with the supplied helper and reference files, read it back, then update its instructions while preserving every supporting file. SKILL-LIBRARY-AUTHOR:bob-worker",
              deliver: false,
              idempotencyKey: authorRunId,
            }),
          ).resolves.toMatchObject({ runId: authorRunId, status: "started" });
          await expect(
            bob.request(
              "agent.wait",
              { runId: authorRunId, timeoutMs: PROOF_TIMEOUT_MS },
              PROOF_TIMEOUT_MS + 5_000,
            ),
          ).resolves.toMatchObject({ status: "ok" });
          const authorOutput = provider.authorOutputs.get("bob-worker");
          if (!authorOutput?.created || !authorOutput.read || !authorOutput.updated) {
            throw new Error("Worker did not return real Workshop create, read and update results");
          }
          const created = JSON.parse(authorOutput.created) as SkillsLibraryReceipt;
          const authored = JSON.parse(authorOutput.updated) as SkillsLibraryReceipt;
          expect(JSON.parse(authorOutput.read)).toMatchObject({
            skillId: created.entry.skillId,
            revision: created.entry.revision,
            content: draft.content,
            contentIncluded: true,
            supportFiles: expect.arrayContaining([
              { path: "scripts/report.mjs", executable: true },
              { path: "references/binary.dat", executable: false },
            ]),
            omittedFiles: 0,
          });
          expect(authored).toMatchObject({
            state: "published",
            target: "personal",
            sessionActivation: "new-sessions",
            entry: {
              ownerProfileId: bobSaved.entry.ownerProfileId,
              authorProfileId: bobSaved.entry.ownerProfileId,
            },
          });
          expect(created.state).toBe("published");
          expect(authored.entry.skillId).toBe(created.entry.skillId);
          expect(authored.entry.revision).not.toBe(created.entry.revision);
          expect(authored.nextAction.trim().length).toBeGreaterThan(0);
          const authoredRead = await bob.request<SkillsLibraryReadResult>("skills.library.read", {
            skillId: authored.entry.skillId,
          });
          expect(authoredRead.entry.revision).toBe(authored.entry.revision);
          expect(authoredRead.content).toBe(authoredContent);
          expect(decodedSkillLibraryFiles(authoredRead.files)).toEqual(
            decodedSkillLibraryFiles(draft.files!),
          );
          const authoredOriginal = await bob.request<SkillsLibraryReadResult>(
            "skills.library.read",
            {
              skillId: created.entry.skillId,
              revision: created.entry.revision,
            },
          );
          expect(authoredOriginal.content).toBe(draft.content);
          expect(decodedSkillLibraryFiles(authoredOriginal.files)).toEqual(
            decodedSkillLibraryFiles(draft.files!),
          );
          await expect(
            alice.request("skills.library.read", { skillId: authored.entry.skillId }),
          ).rejects.toMatchObject({ error: { details: { code: "SKILL_LIBRARY_NOT_FOUND" } } });
          await expect(
            fs.access(path.join(node.stateDir, "skill-library", authored.entry.skillId)),
          ).rejects.toMatchObject({ code: "ENOENT" });
          expect((await sessionLibrary(bob)).session?.selections).toEqual(
            beforeAuthoring.session!.selections,
          );
          expect(await commandCatalog(bob)).toEqual(aliceCommands);
          console.info(
            "[skill-library-wire] verified Gateway-owned Bob publication and unchanged Alice pin",
          );
          await vi.waitFor(
            async () => {
              const history = await bob.request<{ messages: unknown[] }>("chat.history", {
                sessionKey: remoteKey,
                limit: 100,
              });
              expect(
                history.messages.some(
                  (message) =>
                    (message as { role?: string }).role === "assistant" &&
                    wireMessageText(message).includes("AUTHOR-RESULT:bob-worker") &&
                    wireMessageText(message).includes(authored.entry.revision),
                ),
              ).toBe(true);
            },
            { timeout: 30_000, interval: 100 },
          );

          const edited = executableSkillLibraryBundle("ALICE-RESOURCE-2\n");
          const updated = await alice.request<SkillsLibraryReceipt>("skills.library.save", {
            ...edited,
            skillId: saved.entry.skillId,
            expectedRevision: saved.entry.revision,
          });
          expect(updated.entry.revision).not.toBe(saved.entry.revision);
          expect(
            (await readPin(saved.entry.revision)).revisions.map((entry) => entry.revision),
          ).toEqual([saved.entry.revision]);
          await expect(readPin(updated.entry.revision)).rejects.toMatchObject({
            error: { details: { code: "SKILL_LIBRARY_FORBIDDEN" } },
          });
          expect((await turn(alice, localKey, "local-still-pinned")).reference).toBe(
            "ALICE-RESOURCE-1\n",
          );
          expect((await turn(bob, remoteKey, "bob-still-pinned")).reference).toBe(
            "ALICE-RESOURCE-1\n",
          );
          const newKey = await createSession("new-default");
          expect((await turn(alice, newKey, "new-default")).reference).toBe("ALICE-RESOURCE-2\n");

          provider.hold("refresh-during-turn");
          const heldRunId = await startTurn(
            alice,
            remoteKey,
            "refresh-during-turn",
            saved.entry.name,
          );
          await vi.waitFor(() => expect(provider!.isHeld("refresh-during-turn")).toBe(true), {
            timeout: PROOF_TIMEOUT_MS,
            interval: 100,
          });
          const refreshed = await alice.request<SkillsLibraryActivateResult>(
            "skills.library.activate",
            { sessionKey: remoteKey, action: "refresh" },
          );
          expect(refreshed).toMatchObject({
            sessionActivation: "next-turn",
            selections: [{ skillId: saved.entry.skillId, revision: updated.entry.revision }],
          });
          provider.release("refresh-during-turn");
          expect(
            (await finishTurn(alice, remoteKey, "refresh-during-turn", heldRunId)).reference,
          ).toBe("ALICE-RESOURCE-1\n");
          expect((await turn(bob, remoteKey, "after-refresh")).reference).toBe(
            "ALICE-RESOURCE-2\n",
          );

          const extra = await alice.request<SkillsLibraryReceipt>("skills.library.save", {
            ...executableSkillLibraryBundle("EXPLICIT-ATTACH\n"),
            slug: "explicit-attach",
          });
          const attached = await alice.request<SkillsLibraryActivateResult>(
            "skills.library.activate",
            {
              sessionKey: remoteKey,
              action: "attach",
              skillId: extra.entry.skillId,
              revision: extra.entry.revision,
            },
          );
          expect(attached.sessionActivation).toBe("next-turn");
          await turn(alice, remoteKey, "after-attach");
          expect(
            provider.observations.get("after-attach")!.catalogs[0]!.map((skill) => skill.name),
          ).toContain(extra.entry.name);
          await alice.request("skills.library.activate", {
            sessionKey: remoteKey,
            action: "detach",
            skillId: extra.entry.skillId,
          });

          await alice.request("skills.library.mutate", {
            skillId: saved.entry.skillId,
            expectedRevision: updated.entry.revision,
            action: "remove",
          });
          expect((await turn(bob, remoteKey, "after-removal")).reference).toBe(
            "ALICE-RESOURCE-2\n",
          );
          expect((await turn(alice, localKey, "local-after-removal")).reference).toBe(
            "ALICE-RESOURCE-1\n",
          );
          const removedDefaultKey = await createSession("after-remove");
          const removedRunId = await startTurn(alice, removedDefaultKey, "removed-default");
          await expect(
            alice.request(
              "agent.wait",
              { runId: removedRunId, timeoutMs: PROOF_TIMEOUT_MS },
              PROOF_TIMEOUT_MS + 5_000,
            ),
          ).resolves.toMatchObject({ status: "ok" });
          expect(
            provider.observations.get("removed-default")!.catalogs[0]!.map((skill) => skill.name),
          ).not.toContain(saved.entry.name);

          provider.hold("cancelled-worker");
          const cancelledId = await startTurn(
            alice,
            remoteKey,
            "cancelled-worker",
            saved.entry.name,
          );
          await vi.waitFor(() => expect(provider!.isHeld("cancelled-worker")).toBe(true), {
            timeout: PROOF_TIMEOUT_MS,
            interval: 100,
          });
          await expect(
            alice.request("chat.abort", { sessionKey: remoteKey, runId: cancelledId }),
          ).resolves.toMatchObject({ aborted: true });
          const cancelled = await alice.request<{ status: string }>(
            "agent.wait",
            { runId: cancelledId, timeoutMs: PROOF_TIMEOUT_MS },
            PROOF_TIMEOUT_MS + 5_000,
          );
          expect(cancelled.status).not.toBe("timeout");
          provider.release("cancelled-worker");
          expect((await turn(alice, remoteKey, "replacement-worker")).reference).toBe(
            "ALICE-RESOURCE-2\n",
          );
          expect(provider.observations.get("cancelled-worker")!.execOutput).toBeUndefined();
          expect(provider.errors).toEqual([]);

          // Reclaim joins reconciliation before inspecting the final project state.
          console.info("[skill-library-wire] reclaiming placement and checking project state");
          await admin.request("sessions.reclaim", { key: remoteKey }, PROOF_TIMEOUT_MS);
          expect(await workspaceStatus(localCwd)).toBe(localBefore);
          expect(await workspaceStatus(gatewayWorkerCwd)).toBe(workerBefore);
        },
        () => provider?.stop(),
        () => node?.stop(),
        async () => {
          for (const client of clients.toReversed()) {
            await client.close();
          }
        },
        () => instance.cleanup(),
        () => (published ? closeWireServer(published.server) : undefined),
      );
    },
  );
});
