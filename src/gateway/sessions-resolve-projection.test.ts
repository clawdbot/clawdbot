import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { SessionsResolveParams } from "../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadCombinedSessionStoreForGatewayCore } from "../config/sessions/combined-store-gateway.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resetResolvedSessionKeyForRunCacheForTest,
  resolveSessionKeyForRun,
} from "./server-session-key.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { resolveSessionKeyFromResolveParams } from "./sessions-resolve.js";
import { resolveWorkerSessionTarget } from "./worker-environments/session-target.js";

const scope = { agentId: "main", sessionKey: "agent:main:target" };
const entry = { sessionId: "target-id", updatedAt: 1, label: "original" };
const cfg: OpenClawConfig = {
  agents: { ownership: "explicit", entries: { main: {} } },
};
const selectors: SessionsResolveParams[] = [
  { key: scope.sessionKey, agentId: "main" },
  { sessionId: entry.sessionId, agentId: "main" },
  { sessionId: entry.sessionId },
  { label: entry.label, agentId: "main" },
];

function resolve(p: SessionsResolveParams) {
  return resolveSessionKeyFromResolveParams({ cfg, client: null, p });
}

const resolved = { ok: true, key: scope.sessionKey, agentId: "main" };

describe("session resolution metadata", () => {
  it.each(selectors)("resolves %j without decoding unrelated saved prompts", async (p) => {
    await withOpenClawTestState({ label: "resolve-prompts" }, async () => {
      replaceSessionEntrySync(scope, entry);
      for (let index = 0; index < 3; index++) {
        replaceSessionEntrySync(
          { ...scope, sessionKey: `agent:main:sibling-${index}` },
          {
            sessionId: `sibling-${index}`,
            updatedAt: 1,
            skillsSnapshot: { prompt: "unrelated-resolve-prompt".repeat(1024), skills: [] },
          },
        );
      }
      const parse = vi.spyOn(JSON, "parse");
      try {
        expect(await resolve(p)).toEqual(resolved);
        expect(
          parse.mock.calls.filter(([json]) => json.includes("unrelated-resolve-prompt")),
        ).toHaveLength(0);
      } finally {
        parse.mockRestore();
      }
    });
  });

  it("observes same-timestamp external and tracked label/visibility changes", async () => {
    await withOpenClawTestState({ label: "resolve-freshness" }, async () => {
      const client = roleClient("view", "resolve-viewer");
      const roleCfg = { ...cfg, ...rolePolicyConfig() };
      const visible = { ...entry, visibility: "shared" as const };
      replaceSessionEntrySync(scope, visible);
      const lookup = (p: SessionsResolveParams) =>
        resolveSessionKeyFromResolveParams({ cfg: roleCfg, client, p });
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(await lookup({ key: scope.sessionKey })).toEqual(resolved);
        expect(await lookup({ label: entry.label })).toEqual(resolved);
      }
      const external = new DatabaseSync(openOpenClawAgentDatabase(scope).path);
      try {
        const hidden = { ...visible, label: "external", visibility: "draft" };
        external
          .prepare("UPDATE session_nodes SET entry_json = ?, label = ? WHERE session_key = ?")
          .run(JSON.stringify(hidden), hidden.label, scope.sessionKey);
        expect(await lookup({ key: scope.sessionKey, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
        expect(await lookup({ label: hidden.label, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
        expect(await lookup({ label: entry.label, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
        const tracked = { ...visible, label: "tracked" };
        replaceSessionEntrySync(scope, tracked);
        expect(await lookup({ key: scope.sessionKey })).toEqual(resolved);
        expect(await lookup({ label: tracked.label })).toEqual(resolved);
        expect(await lookup({ label: hidden.label, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
      } finally {
        external.close();
      }
    });
  });

  it.each(["malformed", "nul", "mismatched-time", "mismatched-window"])(
    "preserves warm and cold lookup outcomes for %s rows",
    async (kind) => {
      await withOpenClawTestState({ label: "resolve-corruption" }, async () => {
        const siblingKey = "agent:main:sibling";
        replaceSessionEntrySync(scope, entry);
        replaceSessionEntrySync(
          { ...scope, sessionKey: siblingKey },
          { sessionId: "sibling", updatedAt: 1 },
        );
        expect(await resolve({ key: scope.sessionKey })).toEqual(resolved);
        const database = openOpenClawAgentDatabase(scope).db;
        if (kind === "malformed" || kind === "nul") {
          database
            .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
            .run(
              kind === "malformed" ? "{" : JSON.stringify(entry) + "\0trailing",
              scope.sessionKey,
            );
        } else if (kind === "mismatched-time") {
          database
            .prepare("UPDATE session_nodes SET updated_at = ? WHERE session_key = ?")
            .run(2, scope.sessionKey);
        } else {
          database
            .prepare("UPDATE session_nodes SET current_session_id = ? WHERE session_key = ?")
            .run("different", scope.sessionKey);
        }
        expect(await resolve({ key: scope.sessionKey, allowMissing: true })).toEqual(
          kind === "mismatched-window" ? resolved : { ok: true, missing: true },
        );
        expect(await resolve({ key: siblingKey })).toEqual({
          ok: true,
          key: siblingKey,
          agentId: "main",
        });
        closeOpenClawAgentDatabasesForTest();
        expect(await resolve({ key: scope.sessionKey, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
        expect(await resolve({ key: siblingKey, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
      });
    },
  );
});

// Marker lives only in sibling rows the lookups must never decode. A decode of
// this text means a store-wide read carried saved prompts into JavaScript.
const SIBLING_MARKER = "unrelated-lookup-prompt";
const SIBLING_PROMPT = SIBLING_MARKER.repeat(1600);
const TARGET_PROMPT = "target-lookup-prompt".repeat(1600);
const SIBLING_ROWS = 24;

function systemPromptReport(chars: number) {
  return {
    source: "run" as const,
    generatedAt: 1,
    systemPrompt: { chars, projectContextChars: 0, nonProjectContextChars: chars },
    injectedWorkspaceFiles: [],
    skills: { promptChars: chars, entries: [{ name: "seeded-skill", blockChars: chars }] },
    tools: { listChars: 0, schemaChars: 0, entries: [] },
  };
}

function seedStore() {
  replaceSessionEntrySync(scope, {
    sessionId: "target-id",
    updatedAt: 2,
    skillsSnapshot: { prompt: TARGET_PROMPT, skills: [{ name: "target-skill" }] },
    systemPromptReport: systemPromptReport(TARGET_PROMPT.length),
  });
  for (let index = 0; index < SIBLING_ROWS; index++) {
    replaceSessionEntrySync(
      { ...scope, sessionKey: `agent:main:sibling-${index}` },
      {
        sessionId: `sibling-${index}`,
        updatedAt: 1,
        skillsSnapshot: { prompt: SIBLING_PROMPT, skills: [{ name: "sibling-skill" }] },
        systemPromptReport: systemPromptReport(SIBLING_PROMPT.length),
      },
    );
  }
}

/** Counts JSON.parse calls that decoded the sibling marker, plus their input bytes. */
function measureSiblingDecodes<T>(run: () => T): { result: T; decodes: number; bytes: number } {
  const parse = vi.spyOn(JSON, "parse");
  try {
    const result = run();
    const matched = parse.mock.calls.filter(
      ([json]) => typeof json === "string" && json.includes(SIBLING_MARKER),
    );
    return {
      result,
      decodes: matched.length,
      bytes: matched.reduce((total, [json]) => total + (json as string).length, 0),
    };
  } finally {
    parse.mockRestore();
  }
}

describe("gateway session lookups", () => {
  it("resolves a run id without decoding unrelated saved prompts", async () => {
    await withOpenClawTestState({ label: "lookup-runid-projection" }, async () => {
      setRuntimeConfigSnapshot(cfg);
      seedStore();
      resetResolvedSessionKeyForRunCacheForTest();

      const observed = measureSiblingDecodes(() =>
        resolveSessionKeyForRun("target-id", { agentId: "main" }),
      );

      // Caller-facing key drops the agent prefix; see resolveRunSessionKeyForCaller.
      expect(observed.result).toBe("target");
      expect(observed.decodes).toBe(0);
      expect(observed.bytes).toBe(0);

      resetResolvedSessionKeyForRunCacheForTest();
      expect(resolveSessionKeyForRun("absent-run-id", { agentId: "main" })).toBeUndefined();
    });
  });

  it("resolves a worker session target without decoding unrelated saved prompts", async () => {
    await withOpenClawTestState({ label: "lookup-worker-projection" }, async () => {
      setRuntimeConfigSnapshot(cfg);
      seedStore();

      const observed = measureSiblingDecodes(() => resolveWorkerSessionTarget(cfg, "target-id"));

      // This lookup returns the raw canonical key, unlike the run-id lookup.
      expect(observed.result?.sessionKey).toBe(scope.sessionKey);
      expect(observed.result?.agentId).toBe("main");
      expect(observed.result?.sessionId).toBe("target-id");

      // The selected entry is re-read through its own still-full loader, so the
      // narrowed store default must not strip the payload this caller returns.
      expect(observed.result?.sessionEntry.skillsSnapshot?.prompt).toBe(TARGET_PROMPT);

      // This caller reads the store twice: the identity scan fixed here, then
      // resolveGatewaySessionStoreTargetWithStore, which passes no projection and
      // still materializes every row. Only the first read stops decoding, so the
      // remaining count is one pass, not zero; narrowing the second read is
      // separate work because that loader owns the returned entry.
      expect(observed.decodes).toBe(SIBLING_ROWS);

      expect(resolveWorkerSessionTarget(cfg, "absent-session-id")).toBeUndefined();
    });
  });

  it("decodes saved prompts only when a caller opts into the full projection", async () => {
    await withOpenClawTestState({ label: "lookup-projection-arms" }, async () => {
      setRuntimeConfigSnapshot(cfg);
      seedStore();

      // Pre-change behavior: the only production change to the loader is its
      // `??` default, so an explicit "full" read is the pre-change caller.
      const before = measureSiblingDecodes(() =>
        loadCombinedSessionStoreForGatewayCore(cfg, { agentId: "main", projection: "full" }),
      );
      const after = measureSiblingDecodes(() =>
        loadCombinedSessionStoreForGatewayCore(cfg, { agentId: "main" }),
      );

      // Same rows either way: this narrows fields, never the result set.
      expect(Object.keys(before.result.store)).toHaveLength(SIBLING_ROWS + 1);
      expect(Object.keys(after.result.store)).toHaveLength(SIBLING_ROWS + 1);

      // usage reporting and the plugin transcript view stay pinned to "full" and
      // must keep receiving the payload; the narrowed default must not reach them.
      const beforeTarget = before.result.store[scope.sessionKey];
      expect(beforeTarget?.systemPromptReport?.systemPrompt.chars).toBe(TARGET_PROMPT.length);
      expect(beforeTarget?.skillsSnapshot?.prompt).toBe(TARGET_PROMPT);

      const afterTarget = after.result.store[scope.sessionKey];
      expect(afterTarget?.sessionId).toBe("target-id");
      expect(afterTarget?.systemPromptReport).toBeUndefined();
      expect(afterTarget?.skillsSnapshot).toBeUndefined();

      expect(before.decodes).toBe(SIBLING_ROWS);
      expect(before.bytes).toBeGreaterThan(SIBLING_ROWS * SIBLING_PROMPT.length);
      expect(after.decodes).toBe(0);
      expect(after.bytes).toBe(0);

      console.log(
        `[projection-proof] rows=${SIBLING_ROWS + 1} promptBytesPerRow=${SIBLING_PROMPT.length} ` +
          `full: decodes=${before.decodes} decodedBytes=${before.bytes} | ` +
          `list: decodes=${after.decodes} decodedBytes=${after.bytes}`,
      );
    });
  });

  it("keeps the freshest same-session-id row when prompts are not decoded", async () => {
    await withOpenClawTestState({ label: "lookup-projection-freshness" }, async () => {
      setRuntimeConfigSnapshot(cfg);
      // Same sessionId on two keys: selection depends on updatedAt surviving the
      // metadata projection, which is the field a bad projection would drop.
      replaceSessionEntrySync(
        { ...scope, sessionKey: "agent:main:stale" },
        {
          sessionId: "shared-id",
          updatedAt: 1,
          skillsSnapshot: { prompt: SIBLING_PROMPT, skills: [] },
        },
      );
      replaceSessionEntrySync(
        { ...scope, sessionKey: "agent:main:fresh" },
        {
          sessionId: "shared-id",
          updatedAt: 99,
          skillsSnapshot: { prompt: SIBLING_PROMPT, skills: [] },
        },
      );
      resetResolvedSessionKeyForRunCacheForTest();

      const observed = measureSiblingDecodes(() =>
        resolveSessionKeyForRun("shared-id", { agentId: "main" }),
      );
      expect(observed.result).toBe("fresh");
      expect(observed.decodes).toBe(0);
    });
  });
});
