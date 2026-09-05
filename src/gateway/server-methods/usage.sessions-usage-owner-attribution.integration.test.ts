import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { getRuntimeConfig } from "../../config/config.js";
import { encodeSessionArchiveContent } from "../../config/sessions/archive-compression.js";
import { loadCombinedSessionStoreForGatewayCore } from "../../config/sessions/combined-store-gateway.js";
import {
  listSessionTranscriptInstances,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { discoverAllSessions, loadSessionCostSummary } from "../../infra/session-cost-usage.js";
import type { AssistantMessage } from "../../llm/types.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { usageHandlers } from "./usage.js";

it.each([undefined, "agent:opus:slack:dm", "global"])(
  "keeps independent same-id transcripts with opus store key %s through the real usage handler",
  async (opusKey) => {
    const state = await createOpenClawTestState({ label: "usage-owner-integration" });
    try {
      await state.writeConfig({
        agents: { ownership: "explicit", entries: { main: {}, opus: {} } },
        plugins: { enabled: false },
      });
      const config = getRuntimeConfig();
      const sessionId = "shared-usage-session";
      const mainKey = "agent:main:telegram:dm";
      for (const agentId of ["main", "opus"]) {
        const key = agentId === "main" ? mainKey : opusKey;
        const scope = {
          agentId,
          sessionId,
          sessionKey: key ?? `agent:${agentId}:${sessionId}`,
          storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
        };
        if (key) {
          await upsertSessionEntryCore(scope, {
            sessionId,
            updatedAt: Date.now(),
            label: `${agentId} chat`,
          });
        }
        await persistSessionTranscriptTurn(scope, {
          cwd: state.workspaceDir,
          updateMode: "none",
          messages: [
            {
              message: { role: "user", content: `${agentId} turn`, timestamp: Date.now() },
              now: Date.now(),
            },
          ],
        });
      }

      const projected = loadCombinedSessionStoreForGatewayCore(config);
      expect(projected.agentIdBySessionKey.get(mainKey)).toBe("main");
      if (opusKey) {
        expect(projected.agentIdBySessionKey.get(opusKey)).toBe("opus");
      }
      const respond = vi.fn();
      await expectDefined(
        usageHandlers["sessions.usage"],
        "usage handler",
      )({
        params: { agentScope: "all", range: "all", limit: 50 },
        context: { getRuntimeConfig: () => config },
        respond,
      } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
      expect(respond).toHaveBeenCalledOnce();
      const [ok, payload] = expectDefined(respond.mock.calls[0], "usage response");
      expect(ok).toBe(true);
      const result = payload as SessionsUsageResult;
      expect(result.sessions).toHaveLength(2);
      expect(result.sessions.map(({ key, agentId }) => ({ key, agentId }))).toEqual(
        expect.arrayContaining([
          { key: mainKey, agentId: "main" },
          { key: opusKey ?? `agent:opus:${sessionId}`, agentId: "opus" },
        ]),
      );
    } finally {
      await state.cleanup();
    }
  },
);

it.each([
  { name: "SQLite history", artifact: undefined, directOwner: false, currentArtifact: false },
  {
    name: "a direct owner for a historical instance",
    artifact: undefined,
    directOwner: true,
    currentArtifact: false,
  },
  {
    name: "mixed JSONL and SQLite history",
    artifact: "plain",
    directOwner: false,
    currentArtifact: false,
  },
  {
    name: "mixed compressed JSONL and SQLite history",
    artifact: "zstd",
    directOwner: false,
    currentArtifact: false,
  },
  {
    name: "current JSONL discovered after SQLite history",
    artifact: undefined,
    directOwner: false,
    currentArtifact: true,
  },
])(
  "keeps family usage with $name before the current SQLite transcript exists",
  async ({ artifact, directOwner, currentArtifact }) => {
    const state = await createOpenClawTestState({ label: "usage-empty-current-family" });
    try {
      await state.writeConfig({
        agents: { ownership: "explicit", entries: { main: {}, opus: {} } },
        plugins: { enabled: false },
      });
      const config = getRuntimeConfig();
      const mainKey = "agent:main:chat";
      const opusKey = "agent:opus:chat";
      const directKey = "agent:main:chat:run:retained";
      const archiveManager = SessionManager.inMemory(state.workspaceDir);
      const firstId = artifact ? archiveManager.getSessionId() : "family-first";
      const secondId = "family-second";
      const currentId = currentArtifact ? archiveManager.getSessionId() : "family-current";
      const timestamp = Date.now();
      const scopeFor = (agentId: string, sessionKey: string) => ({
        agentId,
        sessionKey,
        storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
      });
      const mainScope = scopeFor("main", mainKey);
      const opusScope = scopeFor("opus", opusKey);
      const usageMessage = (tokens: number): AssistantMessage => ({
        role: "assistant",
        content: [{ type: "text", text: "Recorded usage" }],
        api: "openai-responses",
        provider: "fixture",
        model: "usage-model",
        stopReason: "stop",
        timestamp,
        usage: {
          input: tokens,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: tokens,
          cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
        },
      });
      const writeArtifact = async (tokens: number) => {
        archiveManager.appendMessage(usageMessage(tokens));
        const content = [archiveManager.getHeader(), ...archiveManager.getEntries()]
          .map((entry) => JSON.stringify(entry))
          .join("\n");
        const encoded =
          artifact === "zstd"
            ? encodeSessionArchiveContent(content)
            : { bytes: Buffer.from(content), suffix: "" };
        expect(encoded.suffix).toBe(artifact === "zstd" ? ".zst" : "");
        const filePath = path.join(
          state.sessionsDir(),
          `${archiveManager.getSessionId()}.jsonl.reset.2026-08-01T00-00-00.000Z${encoded.suffix}`,
        );
        await fs.mkdir(state.sessionsDir(), { recursive: true });
        await fs.writeFile(filePath, encoded.bytes);
        return filePath;
      };
      for (const [scope, sessionId, tokens] of [
        [mainScope, firstId, 10],
        [mainScope, secondId, 20],
        [opusScope, firstId, 100],
      ] as const) {
        await upsertSessionEntryCore(scope, {
          sessionId,
          label: `${scope.agentId} chat`,
          updatedAt: timestamp,
        });
        if (artifact && scope.agentId === "main" && sessionId === firstId) {
          await writeArtifact(tokens);
          continue;
        }
        await persistSessionTranscriptTurn(
          { ...scope, sessionId },
          {
            cwd: state.workspaceDir,
            updateMode: "none",
            messages: [{ message: usageMessage(tokens), now: timestamp }],
          },
        );
      }
      const current = await upsertSessionEntryCore(mainScope, {
        sessionId: currentId,
        updatedAt: timestamp + 1,
      });
      if (currentArtifact) {
        const artifactPath = await writeArtifact(40);
        const older = new Date(timestamp - 60_000);
        await fs.utimes(artifactPath, older, older);
      }
      if (directOwner) {
        // Exact-run continuation nodes retain an instance while their logical root rotates.
        await upsertSessionEntryCore(scopeFor("main", directKey), {
          sessionId: firstId,
          label: "retained run",
          updatedAt: timestamp,
        });
      }
      expect(current?.usageFamilySessionIds).toEqual([firstId, secondId, currentId]);
      expect(
        listSessionTranscriptInstances(mainScope)
          .map(({ sessionId }) => sessionId)
          .toSorted(),
      ).toEqual((artifact ? [secondId] : [firstId, secondId]).toSorted());

      // Warm the real rollups so the handler assertion tests selection, not refresh timing.
      for (const agentId of ["main", "opus"]) {
        const discovered = await discoverAllSessions({
          agentId,
          includeFirstUserMessage: false,
        });
        if (currentArtifact && agentId === "main") {
          expect(discovered[0]?.sessionId).not.toBe(currentId);
        }
        for (const { sessionId, sessionFile } of discovered) {
          await loadSessionCostSummary({ agentId, sessionId, sessionFile, config });
        }
      }
      await loadSessionCostSummary({
        agentId: mainScope.agentId,
        sessionId: currentId,
        sessionTarget: { ...mainScope, sessionId: currentId },
        config,
      });

      for (const specificKey of [undefined, mainKey]) {
        const respond = vi.fn();
        await expectDefined(
          usageHandlers["sessions.usage"],
          "usage handler",
        )({
          params: {
            ...(specificKey ? { key: specificKey } : { agentScope: "all" }),
            range: "all",
            groupBy: "family",
            limit: 50,
          },
          context: { getRuntimeConfig: () => config },
          respond,
        } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
        expect(respond).toHaveBeenCalledOnce();
        const [ok, payload] = expectDefined(respond.mock.calls[0], "usage response");
        expect(ok).toBe(true);
        const result = payload as SessionsUsageResult;
        // Explicit keys use the canonical stored target; only list discovery reads current JSONL.
        const mainTokens = currentArtifact && !specificKey ? 70 : directOwner ? 20 : 30;
        expect(result.sessions).toHaveLength(specificKey ? 1 : directOwner ? 3 : 2);
        expect(result.sessions.find(({ key }) => key === mainKey)).toMatchObject({
          key: mainKey,
          agentId: "main",
          label: "main chat",
          sessionId: currentId,
          scope: "family",
          includedSessionIds: directOwner ? [currentId, secondId] : [currentId, firstId, secondId],
          usage: expect.objectContaining({ totalTokens: mainTokens }),
        });
        if (!specificKey) {
          expect(result.sessions.find(({ key }) => key === opusKey)).toMatchObject({
            key: opusKey,
            agentId: "opus",
            sessionId: firstId,
            usage: expect.objectContaining({ totalTokens: 100 }),
          });
          if (directOwner) {
            expect(result.sessions.find(({ key }) => key === directKey)).toMatchObject({
              agentId: "main",
              sessionId: firstId,
              usage: expect.objectContaining({ totalTokens: 10 }),
            });
          }
        }
        expect(result.totals.totalTokens).toBe(
          specificKey ? mainTokens : currentArtifact ? 170 : 130,
        );
      }
    } finally {
      await state.cleanup();
    }
  },
);
