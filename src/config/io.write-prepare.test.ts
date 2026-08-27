// Covers canonical config writes, roster migration, include ownership, and authored env refs.
import { describe, expect, it, vi } from "vitest";
import { collectChangedPaths } from "./config-change-paths.js";
import { applyUnsetPathsForWrite } from "./config-path-mutation.js";
import { restoreEnvRefsFromMap, resolveWriteEnvSnapshotForPath } from "./env-preserve.js";
import { createConfigValidationFailedError } from "./io.write-errors.js";
import { resolvePersistCandidateForWrite } from "./io.write-prepare.js";
import { tryResolveLegacyCompatibilityAgentId } from "./legacy.default-agent-owner.js";
import { migratePersistedImplicitMainRoster } from "./legacy.roster.js";
import { createMergePatch } from "./merge-patch.js";
import { setConfigResolutionFacts } from "./resolution-facts.js";
import type { OpenClawConfig } from "./types.js";

vi.unmock("../agents/agent-scope-config.js");

type PersistInput = Parameters<typeof resolvePersistCandidateForWrite>[0];
type WriteCase = {
  name: string;
  current: unknown;
  next: unknown;
  source?: unknown;
  authored?: unknown;
  before?: unknown;
  options?: Partial<PersistInput>;
  expected?: unknown;
  error?: string;
  verify?: (persisted: OpenClawConfig) => void;
};

const main = { default: true };
const worker = { workspace: "/srv/worker" };
const roster = (entries: Record<string, unknown>) => ({ agents: { entries } });
const listRoster = (list: unknown[]) => ({ agents: { list } });
const identityRef = { source: "env", provider: "default", id: "SSH_IDENTITY" };
const runtimeSecretEntry = {
  default: true,
  sandbox: { ssh: { identityData: "resolved-private-key" } },
};
const authoredSecretEntry = {
  default: true,
  sandbox: { ssh: { identityData: identityRef } },
};

const writeCases: WriteCase[] = [
  {
    name: "persists caller changes onto resolved config without leaking runtime defaults",
    current: {
      gateway: { port: 18789 },
      agents: { defaults: { cliBackend: "codex" } },
      messages: { ackReaction: "eyes" },
      sessions: { persistence: true },
    },
    source: { gateway: { port: 18789 } },
    next: { gateway: { port: 18789, auth: { mode: "token" } } },
    expected: { gateway: { port: 18789, auth: { mode: "token" } } },
  },
  {
    name: "persists the complete injected roster when a pre-roster config adds an agent",
    current: { gateway: { mode: "local" }, ...roster({ main }) },
    authored: { gateway: { mode: "local" } },
    next: { gateway: { mode: "local" }, ...roster({ main, worker }) },
    expected: { gateway: { mode: "local" }, ...roster({ main, worker }) },
  },
  {
    name: "preserves roster siblings for an explicit agent leaf write",
    current: roster({ main, worker }),
    next: roster({ main, worker: { ...worker, default: false } }),
    options: {
      explicitSetPaths: [["agents", "entries", "worker", "default"]],
      explicitSetValueSource: roster({ worker: { default: false } }),
    },
    expected: roster({ main, worker: { ...worker, default: false } }),
  },
  {
    name: "rejects a canonical roster rewrite that silently drops an entry",
    current: roster({ main, worker }),
    next: roster({ worker }),
    error: "Config write would drop agent roster entries without an explicit deletion: main.",
  },
  {
    name: "allows an explicitly authorized agent deletion from the canonical roster",
    current: roster({ main, worker }),
    next: roster({ worker }),
    options: { allowedAgentRosterRemovals: ["main"] },
    expected: roster({ worker }),
  },
  {
    name: "replaces a complete legacy list atomically when the roster changes",
    current: roster({ main, ops: { workspace: "/srv/ops" } }),
    authored: listRoster([
      { id: "main", ...main },
      { id: "ops", workspace: "/srv/ops" },
    ]),
    next: roster({ main, ops: { workspace: "/srv/ops" }, worker }),
    expected: roster({ main, ops: { workspace: "/srv/ops" }, worker }),
  },
  {
    name: "uses the complete next roster when an unrelated explicit value source is present",
    current: roster({ main }),
    next: { ...roster({ main, worker }), gateway: { port: 19001 } },
    options: {
      explicitSetPaths: [["gateway", "port"]],
      explicitSetValueSource: { gateway: { port: 19001 } },
    },
    expected: { ...roster({ main, worker }), gateway: { port: 19001 } },
  },
  {
    name: "preserves non-roster siblings from an explicit agents parent write",
    current: roster({ main }),
    next: roster({ main, worker }),
    options: {
      explicitSetPaths: [["agents"]],
      explicitSetValueSource: {
        agents: {
          defaults: { model: { primary: "openai/gpt-5.5" } },
          entries: { main, worker },
        },
      },
    },
    expected: {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5" } },
        entries: { main, worker },
      },
    },
  },
  {
    name: "preserves authored env references while atomically replacing a legacy roster",
    current: roster({ main: { ...main, agentDir: "/srv/main" } }),
    authored: listRoster([{ id: "main", ...main, agentDir: "${MAIN_AGENT_DIR}" }]),
    next: roster({ main: { ...main, agentDir: "/srv/main" }, worker }),
    expected: roster({ main: { ...main, agentDir: "${MAIN_AGENT_DIR}" }, worker }),
  },
  {
    name: "preserves an unchanged env-backed default during an unrelated roster addition",
    current: roster({ main: { ...main, agentDir: "/srv/main" } }),
    authored: roster({ main: { default: "${MAIN_DEFAULT}", agentDir: "/srv/main" } }),
    next: roster({ main: { ...main, agentDir: "/srv/main" }, worker }),
    expected: roster({ main: { default: "${MAIN_DEFAULT}", agentDir: "/srv/main" }, worker }),
  },
  {
    name: "honors an explicit roster leaf write that equals the resolved runtime value",
    current: roster({ main: { ...main, agentDir: "/srv/main" } }),
    authored: roster({ main: { ...main, agentDir: "${MAIN_AGENT_DIR}" } }),
    next: roster({ main: { ...main, agentDir: "/srv/main" } }),
    options: {
      explicitSetPaths: [["agents", "entries", "main", "agentDir"]],
      explicitSetValueSource: roster({ main: { ...main, agentDir: "/srv/main" } }),
    },
    expected: roster({ main: { ...main, agentDir: "/srv/main" } }),
  },
  {
    name: "honors explicit legacy-list leaves under an env-resolved agent id",
    current: roster({ main: { ...main, agentDir: "/srv/main" } }),
    before: listRoster([{ id: "main", ...main, agentDir: "/srv/main" }]),
    authored: listRoster([{ id: "${AGENT_ID}", ...main, agentDir: "${MAIN_AGENT_DIR}" }]),
    next: roster({ main: { ...main, agentDir: "/srv/main" } }),
    options: {
      explicitSetPaths: [["agents", "list", "0", "agentDir"]],
      explicitSetValueSource: listRoster([{ id: "${AGENT_ID}", ...main, agentDir: "/srv/main" }]),
    },
    expected: roster({ main: { ...main, agentDir: "/srv/main" } }),
  },
  {
    name: "preserves authored refs in a full legacy-list write with an env-backed id",
    current: roster({ main: { ...main, agentDir: "/resolved/old" } }),
    before: listRoster([{ id: "main", ...main, agentDir: "/resolved/old" }]),
    authored: listRoster([{ id: "${AGENT_ID}", ...main, agentDir: "${OLD_DIR}" }]),
    next: roster({ main: { ...main, agentDir: "/resolved/new" } }),
    options: {
      explicitSetPaths: [["agents", "list"]],
      explicitSetValueSource: listRoster([{ id: "${AGENT_ID}", ...main, agentDir: "${NEW_DIR}" }]),
    },
    expected: roster({ main: { ...main, agentDir: "${NEW_DIR}" } }),
  },
  {
    name: "rejects a whole-list write with an unmappable new env-backed id",
    current: roster({ main }),
    before: listRoster([{ id: "main", ...main }]),
    authored: listRoster([{ id: "main", ...main }]),
    next: roster({ main, worker: { workspace: "/resolved/worker" } }),
    options: {
      explicitSetPaths: [["agents", "list"]],
      explicitSetValueSource: listRoster([
        { id: "main", ...main },
        { id: "${WORKER_ID}", workspace: "${WORKER_DIR}" },
      ]),
    },
    error: "cannot safely resolve an explicitly replaced agent list slot",
  },
  {
    name: "keeps explicit legacy-list reorders keyed by each new item id",
    current: roster({ main: { ...main, workspace: "/srv/main" }, ops: { workspace: "/srv/ops" } }),
    before: listRoster([
      { id: "main", ...main, workspace: "/srv/main" },
      { id: "ops", workspace: "/srv/ops" },
    ]),
    authored: listRoster([
      { id: "main", ...main, workspace: "/srv/main" },
      { id: "ops", workspace: "/srv/ops" },
    ]),
    next: listRoster([
      { id: "ops", workspace: "/srv/ops" },
      { id: "main", ...main, workspace: "/srv/main" },
    ]),
    options: {
      explicitSetPaths: [["agents", "list"]],
      explicitSetValueSource: listRoster([
        { id: "ops", workspace: "/srv/ops" },
        { id: "main", ...main, workspace: "/srv/main" },
      ]),
    },
    expected: roster({ ops: { workspace: "/srv/ops" }, main: { ...main, workspace: "/srv/main" } }),
  },
  {
    name: "preserves unchanged authored array elements during partial roster changes",
    current: roster({ main: { ...main, tools: { allow: ["read", "old"] } } }),
    authored: roster({ main: { ...main, tools: { allow: ["${PRIMARY_TOOL}", "old"] } } }),
    next: roster({ main: { ...main, tools: { allow: ["read", "new"] } } }),
    expected: roster({ main: { ...main, tools: { allow: ["${PRIMARY_TOOL}", "new"] } } }),
  },
  {
    name: "preserves authored secret references in unchanged roster fields",
    current: roster({ main: runtimeSecretEntry }),
    source: roster({ main: authoredSecretEntry }),
    authored: roster({ main: authoredSecretEntry }),
    next: roster({ main: runtimeSecretEntry, worker }),
    expected: roster({ main: authoredSecretEntry, worker }),
  },
  {
    name: "preserves an entry-internal include while atomically adding an agent",
    current: roster({ main: { ...main, identity: { name: "Main", emoji: "🦞" } } }),
    authored: roster({ main: { ...main, identity: { $include: "./identity.json" } } }),
    next: roster({ main: { ...main, identity: { name: "Main", emoji: "🦞" } }, worker }),
    expected: roster({ main: { ...main, identity: { $include: "./identity.json" } }, worker }),
  },
  {
    name: "preserves an entry-internal include authored in a legacy list while adding an agent",
    current: roster({ main: { ...main, identity: { name: "Main", emoji: "🦞" } } }),
    before: listRoster([{ id: "main", ...main, identity: { name: "Main", emoji: "🦞" } }]),
    authored: listRoster([{ id: "main", ...main, identity: { $include: "./identity.json" } }]),
    next: roster({ main: { ...main, identity: { name: "Main", emoji: "🦞" } }, worker }),
    expected: roster({ main: { ...main, identity: { $include: "./identity.json" } }, worker }),
  },
  {
    name: "rejects a roster write when a legacy whole-entry include owns the agent id",
    current: roster({ main }),
    before: listRoster([{ id: "main", ...main }]),
    authored: listRoster([{ $include: "./main-agent.json" }]),
    next: roster({ main, worker }),
    error: "flatten $include-owned config at agents",
  },
  {
    name: "rejects a roster write that changes an entry-internal included subtree",
    current: roster({ main: { ...main, identity: { name: "Main", emoji: "🦞" } } }),
    authored: roster({ main: { ...main, identity: { $include: "./identity.json" } } }),
    next: roster({ main: { ...main, identity: { name: "Changed", emoji: "🦞" } }, worker }),
    error: "flatten $include-owned config at agents.entries.main.identity",
  },
  {
    name: "preserves authored references when an agent id is renamed",
    current: roster({ main: runtimeSecretEntry }),
    source: roster({ main: authoredSecretEntry }),
    before: listRoster([{ id: "main", ...authoredSecretEntry }]),
    authored: listRoster([{ id: "main", ...authoredSecretEntry }]),
    next: roster({ primary: runtimeSecretEntry }),
    options: {
      explicitSetPaths: [["agents", "list", "0", "id"]],
      explicitSetValueSource: listRoster([{ id: "primary", ...runtimeSecretEntry }]),
      allowedAgentRosterRemovals: ["main"],
    },
    expected: roster({ primary: authoredSecretEntry }),
  },
  {
    name: "rejects an env-backed agent rename whose resolved identity is unavailable",
    current: roster({ main }),
    before: listRoster([{ id: "main", ...main }]),
    authored: listRoster([{ id: "${OLD_AGENT_ID}", ...main }]),
    next: roster({ ops: main }),
    options: {
      explicitSetPaths: [["agents", "list", "0", "id"]],
      explicitSetValueSource: listRoster([{ id: "${NEW_AGENT_ID}", ...main }]),
    },
    error: "cannot safely resolve an env-backed renamed agent id",
  },
  {
    name: "applies a legacy-list unset to the renamed canonical entry",
    current: roster({ main: { ...main, workspace: "/srv/main" } }),
    before: listRoster([{ id: "main", ...main, workspace: "/srv/main" }]),
    authored: listRoster([{ id: "main", ...main, workspace: "/srv/main" }]),
    next: roster({ primary: main }),
    options: {
      explicitSetPaths: [["agents", "list", "0", "id"]],
      explicitSetValueSource: listRoster([{ id: "primary", ...main }]),
      unsetPaths: [["agents", "list", "0", "workspace"]],
      allowedAgentRosterRemovals: ["main"],
    },
    expected: roster({ primary: main }),
  },
  {
    name: "applies an indexed unset after an explicit legacy-list reorder with a resolved id",
    current: roster({ main: { ...main, workspace: "/srv/main" }, worker }),
    source: listRoster([
      { id: "main", ...main, workspace: "/srv/main" },
      { id: "worker", ...worker },
    ]),
    before: listRoster([
      { id: "main", ...main, workspace: "/srv/main" },
      { id: "worker", ...worker },
    ]),
    authored: listRoster([
      { id: "main", ...main, workspace: "/srv/main" },
      { id: "${WORKER_ID}", ...worker },
    ]),
    next: roster({ worker: {}, main: { ...main, workspace: "/srv/main" } }),
    options: {
      explicitSetPaths: [["agents", "list"]],
      explicitSetValueSource: listRoster([
        { id: "${WORKER_ID}" },
        { id: "main", ...main, workspace: "/srv/main" },
      ]),
      unsetPaths: [["agents", "list", "0", "workspace"]],
    },
    expected: roster({ worker: {}, main: { ...main, workspace: "/srv/main" } }),
  },
  {
    name: "removes the explicitly reordered list slot instead of the surviving agent",
    current: roster({ main, "0": worker }),
    source: listRoster([
      { id: "main", ...main },
      { id: "0", ...worker },
    ]),
    authored: listRoster([
      { id: "main", ...main },
      { id: "0", ...worker },
    ]),
    next: roster({ main }),
    options: {
      explicitSetPaths: [["agents", "list"]],
      explicitSetValueSource: listRoster([
        { id: "0", ...worker },
        { id: "main", ...main },
      ]),
      unsetPaths: [["agents", "list", "0"]],
      allowedAgentRosterRemovals: ["0"],
    },
    expected: roster({ main }),
  },
  {
    name: "rejects an unprovable newly introduced environment-backed id",
    current: roster({ main, worker_id: { workspace: "/srv/existing" } }),
    source: listRoster([
      { id: "main", ...main },
      { id: "worker_id", workspace: "/srv/existing" },
    ]),
    authored: listRoster([
      { id: "main", ...main },
      { id: "worker_id", workspace: "/srv/existing" },
    ]),
    next: roster({ "new-worker": {}, worker_id: { workspace: "/srv/existing" }, main }),
    options: {
      explicitSetPaths: [["agents", "list"]],
      explicitSetValueSource: listRoster([
        { id: "${WORKER_ID}" },
        { id: "worker_id", workspace: "/srv/existing" },
        { id: "main", ...main },
      ]),
      unsetPaths: [["agents", "list", "0", "workspace"]],
    },
    error: "cannot safely resolve an explicitly replaced agent list slot",
  },
  {
    name: "rejects an indexed unset across duplicate explicit list ids",
    current: roster({ worker: { workspace: "/old" } }),
    source: listRoster([{ id: "worker", workspace: "/old" }]),
    before: listRoster([{ id: "worker", workspace: "/old" }]),
    authored: listRoster([{ id: "${WORKER_ID}", workspace: "/old" }]),
    next: roster({ worker: { workspace: "/second" } }),
    options: {
      explicitSetPaths: [["agents", "list"]],
      explicitSetValueSource: listRoster([
        { id: "${WORKER_ID}", workspace: "/first" },
        { id: "worker", workspace: "/second" },
      ]),
      unsetPaths: [["agents", "list", "0"]],
    },
    error: 'cannot canonicalize duplicate normalized agent id "worker"',
  },
  {
    name: "rejects duplicate normalized ids in an explicit legacy-list value source",
    current: roster({ main }),
    before: listRoster([{ id: "main", ...main }]),
    authored: listRoster([{ id: "main", ...main }]),
    next: roster({ main }),
    options: {
      explicitSetPaths: [["agents", "list"]],
      explicitSetValueSource: listRoster([{ id: "Ops", ...main }, { id: " ops " }]),
    },
    error: 'Config write cannot canonicalize duplicate normalized agent id "ops".',
  },
  {
    name: "keys legacy authored references by the pre-migration resolved agent id",
    current: roster({ main: runtimeSecretEntry }),
    source: roster({ main: authoredSecretEntry }),
    before: listRoster([{ id: "main", ...authoredSecretEntry }]),
    authored: listRoster([{ id: "${AGENT_ID}", ...authoredSecretEntry }]),
    next: roster({ main: runtimeSecretEntry, worker }),
    expected: roster({ main: authoredSecretEntry, worker }),
  },
  {
    name: "rejects ambiguous one-for-one replacements with authored references",
    current: roster({ main: runtimeSecretEntry }),
    source: roster({ main: authoredSecretEntry }),
    authored: roster({ main: authoredSecretEntry }),
    next: roster({ worker: { ...main, ...worker } }),
    error: "cannot safely match renamed agent entries",
  },
  {
    name: "keeps the normalized default when authored legacy input marked it false",
    current: roster({ main, ops: { workspace: "/srv/ops" } }),
    before: listRoster([
      { id: "main", default: false },
      { id: "ops", workspace: "/srv/ops" },
    ]),
    authored: listRoster([
      { id: "main", default: false },
      { id: "ops", workspace: "/srv/ops" },
    ]),
    next: roster({ main, ops: { workspace: "/srv/ops" }, worker }),
    expected: roster({ main, ops: { workspace: "/srv/ops" }, worker }),
  },
  {
    name: "preserves authored references when roster arrays shift",
    current: roster({ main: { ...main, tools: { allow: ["read", "old"] } } }),
    authored: roster({ main: { ...main, tools: { allow: ["${PRIMARY_TOOL}", "old"] } } }),
    next: roster({ main: { ...main, tools: { allow: ["new", "read", "old"] } } }),
    expected: roster({ main: { ...main, tools: { allow: ["new", "${PRIMARY_TOOL}", "old"] } } }),
  },
  {
    name: "does not reuse an authored array reference after its source element was consumed",
    current: roster({ main: { ...main, tools: { allow: ["a", "b"] } } }),
    authored: roster({ main: { ...main, tools: { allow: ["${TOOL_A}", "${TOOL_B}"] } } }),
    next: roster({ main: { ...main, tools: { allow: ["b", "b"] } } }),
    expected: roster({ main: { ...main, tools: { allow: ["${TOOL_B}", "b"] } } }),
  },
  {
    name: "rejects unsetting an id inside a legacy list entry",
    current: roster({ main }),
    authored: listRoster([{ id: "main", ...main }]),
    next: roster({ main }),
    options: { unsetPaths: [["agents", "list", "0", "id"]] },
    error: "cannot unset an agent id",
  },
  {
    name: "does not resurrect an authored roster removed from the complete next config",
    current: { agents: { defaults: { workspace: "/srv/default" }, entries: { main } } },
    next: { agents: { defaults: { workspace: "/srv/default" } } },
    expected: { agents: { defaults: { workspace: "/srv/default" } } },
  },
  {
    name: "allows roster writes beside unrelated root includes using pre-migration provenance",
    current: roster({ main }),
    before: { channels: { telegram: { enabled: true } } },
    authored: { $include: "./channels.json" },
    next: roster({ main, worker }),
    expected: { $include: "./channels.json", ...roster({ main, worker }) },
  },
  {
    name: "preserves an authored legacy list when a non-roster field changes",
    current: { ...roster({ main, ops: { workspace: "/srv/ops" } }), gateway: { port: 18789 } },
    authored: {
      ...listRoster([
        { id: "main", ...main },
        { id: "ops", workspace: "/srv/ops" },
      ]),
      gateway: { port: 18789 },
    },
    next: { ...roster({ main, ops: { workspace: "/srv/ops" } }), gateway: { port: 19001 } },
    expected: {
      ...listRoster([
        { id: "main", ...main },
        { id: "ops", workspace: "/srv/ops" },
      ]),
      gateway: { port: 19001 },
    },
  },
  {
    name: "preserves untouched include-owned subtrees during unrelated writes",
    current: { agents: { defaults: { model: "openai/gpt-5.4" } }, gateway: { mode: "local" } },
    authored: { agents: { $include: "./config/agents.json" }, gateway: { mode: "local" } },
    next: {
      agents: { defaults: { model: "openai/gpt-5.4" } },
      gateway: { mode: "local", port: 18789 },
    },
    expected: {
      agents: { $include: "./config/agents.json" },
      gateway: { mode: "local", port: 18789 },
    },
  },
  {
    name: "allows removing root-authored sibling keys beside an include",
    current: { gateway: { mode: "local", legacyKey: true } },
    authored: { gateway: { $include: "./config/gateway.json", legacyKey: true } },
    next: { gateway: { mode: "local" } },
    expected: { gateway: { $include: "./config/gateway.json" } },
  },
  {
    name: "allows nested root-authored sibling edits without flattening included values",
    current: { gateway: { mode: "local", auth: { mode: "token", token: "old" } } },
    authored: { gateway: { $include: "./config/gateway.json", auth: { token: "old" } } },
    next: { gateway: { mode: "local", auth: { mode: "none", token: "new", strategy: "strict" } } },
    expected: {
      gateway: {
        $include: "./config/gateway.json",
        auth: { token: "new", mode: "none", strategy: "strict" },
      },
    },
  },
  {
    name: "does not copy runtime-normalized include values into root-authored siblings",
    current: { gateway: { tls: { certPath: "/home/test/cert.pem", enabled: false } } },
    source: { gateway: { tls: { certPath: "~/cert.pem", enabled: false } } },
    authored: { gateway: { $include: "./config/gateway.json", tls: { enabled: false } } },
    next: { gateway: { tls: { certPath: "~/cert.pem", enabled: true } } },
    expected: { gateway: { $include: "./config/gateway.json", tls: { enabled: true } } },
  },
  {
    name: "rejects included-value edits beside root-authored sibling edits",
    current: { gateway: { mode: "local", legacyKey: "old" } },
    authored: { gateway: { $include: "./config/gateway.json", legacyKey: "old" } },
    next: { gateway: { mode: "remote", legacyKey: "new" } },
    error: "Config write would flatten $include-owned config at gateway",
  },
  {
    name: "preserves include-owned array entries across runtime-only normalization",
    current: {
      ...listRoster([{ id: "main", workspace: "/home/test/agent" }]),
      gateway: { mode: "local" },
    },
    source: { ...listRoster([{ id: "main", workspace: "~/agent" }]), gateway: { mode: "local" } },
    authored: {
      ...listRoster([{ $include: "./config/main-agent.json" }]),
      gateway: { mode: "local" },
    },
    next: {
      ...listRoster([{ id: "main", workspace: "~/agent" }]),
      gateway: { mode: "local", port: 18789 },
    },
    expected: {
      ...listRoster([{ $include: "./config/main-agent.json" }]),
      gateway: { mode: "local", port: 18789 },
    },
  },
  {
    name: "rejects roster edits beside an include-owned array entry",
    current: listRoster([
      { id: "main", workspace: "~/agent" },
      { id: "ops", workspace: "~/ops" },
    ]),
    authored: listRoster([
      { $include: "./config/main-agent.json" },
      { id: "ops", workspace: "~/ops" },
    ]),
    next: listRoster([
      { id: "main", workspace: "~/agent" },
      { id: "ops", workspace: "~/ops-next" },
      { id: "new", workspace: "~/new" },
    ]),
    error: "Config write would flatten $include-owned config at agents",
  },
  {
    name: "rejects writes that change include-owned array entries",
    current: listRoster([{ id: "main", workspace: "~/agent" }]),
    authored: listRoster([{ $include: "./config/main-agent.json" }]),
    next: listRoster([{ id: "main", workspace: "~/other-agent" }]),
    error: "Config write would flatten $include-owned config at agents",
  },
  {
    name: "rejects array shifts when an included value has a duplicate sibling",
    current: { plugins: { load: { paths: ["/same", "/same"] } } },
    authored: { plugins: { load: { paths: [{ $include: "./path.json5" }, "/same"] } } },
    next: { plugins: { load: { paths: ["/same"] } } },
    error: "Config write would flatten $include-owned config at plugins.load.paths.0",
  },
  {
    name: "allows unrelated removals after duplicate include-resolved values",
    current: { plugins: { load: { paths: ["/same", "/same", "/other"] } } },
    authored: {
      plugins: { load: { paths: [{ $include: "./path.json5" }, "/same", "/other"] } },
    },
    next: { plugins: { load: { paths: ["/same", "/same"] } } },
    expected: { plugins: { load: { paths: [{ $include: "./path.json5" }, "/same"] } } },
  },
  {
    name: "rejects included-entry removals hidden by duplicate sibling edits",
    current: { plugins: { load: { paths: ["/same", "/same", "/old"] } } },
    authored: {
      plugins: { load: { paths: [{ $include: "./path.json5" }, "/same", "/old"] } },
    },
    next: { plugins: { load: { paths: ["/same", "/new"] } } },
    error: "Config write would flatten $include-owned config at plugins.load.paths.0",
  },
  {
    name: "rejects newly introduced duplicates of include-owned array entries",
    current: { plugins: { load: { paths: ["/root", "/included"] } } },
    authored: { plugins: { load: { paths: ["/root", { $include: "./path.json5" }] } } },
    next: { plugins: { load: { paths: ["/included", "/included"] } } },
    error: "Config write would flatten $include-owned config at plugins.load.paths.1",
  },
  {
    name: "rejects writes that would flatten include-owned subtrees",
    current: { agents: { defaults: { model: "openai/gpt-5.4" } } },
    authored: { agents: { $include: "./config/agents.json" } },
    next: { agents: { defaults: { model: "anthropic/sonnet-4.5" } } },
    error: "Config write would flatten $include-owned config at agents",
  },
  {
    name: "preserves root $schema during unrelated partial writes",
    current: { $schema: "https://openclaw.ai/config.json", gateway: { mode: "local" } },
    next: { gateway: { mode: "local", port: 18789 } },
    expected: {
      $schema: "https://openclaw.ai/config.json",
      gateway: { mode: "local", port: 18789 },
    },
  },
  {
    name: "rejects writes that would flatten a root include",
    current: {
      $schema: "https://openclaw.ai/config-from-include.json",
      gateway: { mode: "local" },
    },
    authored: { $include: "./extra.json5", gateway: { mode: "local" } },
    next: { gateway: { mode: "local", port: 18789 } },
    error: "Config write would flatten $include-owned config at <root>",
  },
  {
    name: "does not restore root $schema when the next config explicitly clears it",
    current: { $schema: "https://openclaw.ai/config.json", gateway: { mode: "local" } },
    next: { $schema: null, gateway: { mode: "local", port: 18789 } },
    expected: { gateway: { mode: "local", port: 18789 } },
  },
  {
    name: "does not restore root $schema when the next config sets an invalid value",
    current: { $schema: "https://openclaw.ai/config.json", gateway: { mode: "local" } },
    next: { $schema: 123, gateway: { mode: "local", port: 18789 } },
    expected: { $schema: 123, gateway: { mode: "local", port: 18789 } },
  },
];

function resolveWriteCase(testCase: WriteCase): OpenClawConfig {
  return resolvePersistCandidateForWrite({
    runtimeConfig: testCase.current,
    sourceConfig: testCase.source ?? testCase.current,
    nextConfig: testCase.next,
    ...(testCase.authored === undefined ? {} : { rootAuthoredConfig: testCase.authored }),
    ...(testCase.before === undefined ? {} : { sourceConfigBeforeMigrations: testCase.before }),
    ...testCase.options,
  }) as OpenClawConfig;
}

describe("config io write prepare", () => {
  it.each(writeCases)("$name", (testCase) => {
    if (testCase.error) {
      expect(() => resolveWriteCase(testCase)).toThrow(testCase.error);
      return;
    }
    const persisted = resolveWriteCase(testCase);
    expect(persisted).toEqual(testCase.expected);
    testCase.verify?.(persisted);
  });

  it("uses recorded facts instead of placeholder-shaped roster bytes", () => {
    const literalId = "${AGENT_ID}";
    const sourceConfigBeforeMigrations = listRoster([{ id: literalId, ...main }]);
    const resolveRename = () =>
      resolvePersistCandidateForWrite({
        runtimeConfig: roster({ [literalId]: main }),
        sourceConfig: roster({ [literalId]: main }),
        sourceConfigBeforeMigrations,
        rootAuthoredConfig: listRoster([{ id: literalId, ...main }]),
        nextConfig: roster({ renamed: main }),
        explicitSetPaths: [["agents", "list", "0", "id"]],
        explicitSetValueSource: listRoster([{ id: "renamed", ...main }]),
        allowedAgentRosterRemovals: [literalId],
      });

    setConfigResolutionFacts(sourceConfigBeforeMigrations, new Set(["agents.list[0].id"]));
    expect(resolveRename).toThrow("cannot safely resolve an env-backed renamed agent id");

    setConfigResolutionFacts(sourceConfigBeforeMigrations, new Set());
    expect(resolveRename()).toEqual(roster({ renamed: main }));
  });

  it("ignores prototype-chain keys when building merge patches", () => {
    const base = { safe: { mode: "local" }, collision: { mode: "owned-base" } };
    const target = Object.create({ collision: { mode: "inherited-target" } }) as Record<
      string,
      unknown
    >;
    target.safe = { mode: "cloud" };
    expect(createMergePatch(base, target)).toEqual({
      safe: { mode: "cloud" },
      collision: null,
    });
  });

  it("preserves an untouched legacy owner marker across a partial unrelated write", () => {
    const authored = {
      agents: { entries: { ops: {}, research: { default: true } } },
      gateway: { port: 18789 },
    };
    const migrated = migratePersistedImplicitMainRoster(authored).config as OpenClawConfig;

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: migrated,
      sourceConfig: migrated,
      sourceConfigBeforeMigrations: authored,
      rootAuthoredConfig: authored,
      nextConfig: { gateway: { port: 19001 } },
      preserveLegacyAgentRoster: true,
      explicitSetPaths: [["gateway", "port"]],
      explicitSetValueSource: { gateway: { port: 19001 } },
    }) as OpenClawConfig;

    expect(persisted.agents?.entries?.research?.default).toBe(true);
    const reloaded = migratePersistedImplicitMainRoster(persisted).config as OpenClawConfig;
    expect(tryResolveLegacyCompatibilityAgentId(reloaded)).toBe("research");
  });

  it("rejects duplicate normalized ids before canonicalizing a legacy roster", () => {
    const nextConfig = listRoster([
      { id: "Ops", workspace: "/first" },
      { id: " ops ", workspace: "/second" },
    ]);
    const before = structuredClone(nextConfig);
    expect(() =>
      resolvePersistCandidateForWrite({
        runtimeConfig: {},
        sourceConfig: {},
        nextConfig,
        explicitSetPaths: [["agents", "list"]],
        explicitSetValueSource: nextConfig,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "DuplicateAgentRosterIdError",
        message: 'Config write cannot canonicalize duplicate normalized agent id "ops".',
      }),
    );
    expect(nextConfig).toEqual(before);
  });

  it.each([
    {
      name: "translates a legacy list unset before canonicalizing the roster",
      canonicalSource: false,
    },
    {
      name: "translates a legacy list unset after the source roster has been canonicalized",
      canonicalSource: true,
    },
  ])("$name", ({ canonicalSource }) => {
    const entries = { main, worker };
    const legacy = listRoster([
      { id: "main", ...main },
      { id: "worker", ...worker },
    ]);
    const unsetPaths = [["agents", "list", "1"]];
    expect(
      applyUnsetPathsForWrite(
        resolvePersistCandidateForWrite({
          runtimeConfig: roster(entries),
          sourceConfig: canonicalSource ? roster(entries) : legacy,
          ...(canonicalSource ? { sourceConfigBeforeMigrations: legacy } : {}),
          rootAuthoredConfig: legacy,
          nextConfig: roster(entries),
          unsetPaths,
          allowedAgentRosterRemovals: ["worker"],
        }) as OpenClawConfig,
        unsetPaths,
      ),
    ).toEqual(roster({ main }));
  });

  it("omits canonical entries when the complete legacy list is unset", () => {
    const unsetPaths = [["agents", "list"]];
    const persisted = applyUnsetPathsForWrite(
      resolvePersistCandidateForWrite({
        runtimeConfig: roster({ main }),
        sourceConfig: roster({ main }),
        rootAuthoredConfig: listRoster([{ id: "main", ...main }]),
        nextConfig: roster({ main }),
        unsetPaths,
        allowedAgentRosterRemovals: ["main"],
      }) as OpenClawConfig,
      unsetPaths,
    );
    expect(persisted.agents).not.toHaveProperty("list");
    expect(persisted.agents).not.toHaveProperty("entries");
  });

  it("strips transient plugin install records from partial writes", () => {
    const install = {
      source: "npm",
      spec: "@ollama/openclaw-web-search",
      installPath: "/tmp/openclaw-web-search",
      resolvedName: "@ollama/openclaw-web-search",
      resolvedVersion: "0.2.2",
    };
    const persisted = applyUnsetPathsForWrite(
      resolvePersistCandidateForWrite({
        runtimeConfig: { plugins: { entries: {} } },
        sourceConfig: { plugins: { entries: {}, installs: { "openclaw-web-search": install } } },
        nextConfig: {
          plugins: {
            entries: {},
            installs: {
              "openclaw-web-search": { ...install, spec: "@ollama/openclaw-web-search@0.2.2" },
            },
          },
        },
      }) as OpenClawConfig,
      [["plugins", "installs"]],
    );
    expect(persisted.plugins).not.toHaveProperty("installs");
  });

  it("preserves authored agent provider params during narrowed agent-list writes", () => {
    const defaults = {
      params: { transport: "sse", openaiWsWarmup: false },
      models: {
        "openai/gpt-5.4": {
          alias: "GPT",
          params: { transport: "sse", openaiWsWarmup: false },
        },
      },
    };
    const sourceConfig = {
      agents: { defaults, list: [{ id: "main" }] },
      gateway: { mode: "local" },
    };
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig: {
          ...sourceConfig,
          agents: { ...sourceConfig.agents, defaults: { ...defaults, maxConcurrent: 4 } },
        },
        sourceConfig,
        nextConfig: {
          agents: { list: [{ id: "main" }, { id: "ops" }] },
          gateway: { mode: "local" },
        },
      }),
    ).toEqual({ agents: { defaults, entries: { main: {}, ops: {} } }, gateway: { mode: "local" } });
  });

  it("preserves authored Google model params under normalized config keys", () => {
    const params = { thinking: { level: "high" } };
    const sourceConfig = {
      agents: {
        defaults: {
          model: { primary: "google/gemini-3-pro-preview" },
          models: { "google/gemini-3-pro-preview": { alias: "Gemini", params } },
        },
      },
    };
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig: {
          agents: {
            defaults: {
              model: { primary: "google/gemini-3.1-pro-preview" },
              models: {
                "google/gemini-3.1-pro-preview": { alias: "Gemini", params },
              },
            },
          },
        },
        sourceConfig,
        nextConfig: {
          agents: {
            defaults: {
              model: { primary: "google/gemini-3.1-pro-preview" },
              models: { "google/gemini-3.1-pro-preview": {} },
            },
          },
        },
      }),
    ).toEqual({
      agents: {
        defaults: {
          model: { primary: "google/gemini-3-pro-preview" },
          models: { "google/gemini-3.1-pro-preview": { params } },
        },
      },
    });
  });

  it("canonicalizes only agent model maps touched through normalized runtime identities", () => {
    const retired = "google/gemini-3-pro-preview";
    const canonical = "google/gemini-3.1-pro-preview";
    const sourceConfig = {
      agents: {
        defaults: {
          models: {
            [retired]: { alias: "Default before", agentRuntime: { id: "codex" } },
          },
        },
        entries: { ops: { models: { [retired]: { alias: "Ops before" } } } },
      },
    };
    const runtimeConfig = {
      agents: {
        defaults: {
          models: {
            [canonical]: { alias: "Default before", agentRuntime: { id: "codex" } },
          },
        },
        entries: { ops: { models: { [canonical]: { alias: "Ops before" } } } },
      },
    };

    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig,
        sourceConfig,
        nextConfig: {
          agents: {
            defaults: {
              models: {
                [canonical]: { alias: "Default after", agentRuntime: { id: "codex" } },
              },
            },
            entries: { ops: { models: { [canonical]: { alias: "Ops after" } } } },
          },
        },
      }),
    ).toEqual({
      agents: {
        defaults: {
          models: {
            [canonical]: { alias: "Default after", agentRuntime: { id: "codex" } },
          },
        },
        entries: { ops: { models: { [canonical]: { alias: "Ops after" } } } },
      },
    });
  });

  it("leaves untouched retired model maps for doctor instead of normalizing unrelated writes", () => {
    const retired = "google/gemini-3-pro-preview";
    const canonical = "google/gemini-3.1-pro-preview";
    const sourceConfig = {
      agents: { defaults: { models: { [retired]: { alias: "Gemini" } } } },
      gateway: { port: 18789 },
    };
    const runtimeConfig = {
      agents: { defaults: { models: { [canonical]: { alias: "Gemini" } } } },
      gateway: { port: 18789 },
    };

    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig,
        sourceConfig,
        nextConfig: { ...runtimeConfig, gateway: { port: 18888 } },
      }),
    ).toEqual({
      agents: { defaults: { models: { [retired]: { alias: "Gemini" } } } },
      gateway: { port: 18888 },
    });
  });

  it("canonicalizes an explicitly persisted model-map path even when runtime values are equal", () => {
    const retired = "google/gemini-3-pro-preview";
    const canonical = "google/gemini-3.1-pro-preview";
    const sourceConfig = {
      agents: { defaults: { models: { [retired]: { alias: "Gemini" } } } },
    };
    const runtimeConfig = {
      agents: { defaults: { models: { [canonical]: { alias: "Gemini" } } } },
    };

    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig,
        sourceConfig,
        nextConfig: runtimeConfig,
        explicitSetPaths: [["agents", "defaults", "models"]],
      }),
    ).toEqual(runtimeConfig);
  });

  it("canonicalizes only the model identity selected by an explicit descendant path", () => {
    const retiredA = "google/gemini-3-pro-preview";
    const canonicalA = "google/gemini-3.1-pro-preview";
    const retiredB = "google/gemma-4-26b";
    const canonicalB = "google/gemma-4-26b-a4b-it";
    const sourceConfig = {
      agents: {
        defaults: {
          models: {
            [retiredA]: { alias: "Gemini" },
            [retiredB]: { alias: "Gemma" },
          },
        },
      },
    };
    const runtimeConfig = {
      agents: {
        defaults: {
          models: {
            [canonicalA]: { alias: "Gemini" },
            [canonicalB]: { alias: "Gemma" },
          },
        },
      },
    };

    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig,
        sourceConfig,
        nextConfig: runtimeConfig,
        explicitSetPaths: [["agents", "defaults", "models", canonicalA, "alias"]],
      }),
    ).toEqual({
      agents: {
        defaults: {
          models: {
            [canonicalA]: { alias: "Gemini" },
            [retiredB]: { alias: "Gemma" },
          },
        },
      },
    });
  });

  it("does not reintroduce legacy openai-codex model params after doctor route repair", () => {
    const params = { reasoning_effort: "high" };
    const sourceConfig = {
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.5",
          models: { "openai-codex/gpt-5.5": { params } },
        },
      },
    };
    const nextConfig = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          models: { "openai/gpt-5.5": { params, agentRuntime: { id: "codex" } } },
        },
      },
    };
    expect(
      resolvePersistCandidateForWrite({ runtimeConfig: sourceConfig, sourceConfig, nextConfig }),
    ).toEqual(nextConfig);
  });

  it("allows explicit unsets to remove authored agent provider params", () => {
    const params = { transport: "sse", openaiWsWarmup: false };
    const current = {
      agents: { defaults: { params, models: { "openai/gpt-5.4": { params } } } },
    };
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig: current,
        sourceConfig: current,
        nextConfig: { agents: { defaults: { models: { "openai/gpt-5.4": {} } } } },
        unsetPaths: [
          ["agents", "defaults", "params"],
          ["agents", "defaults", "models", "openai/gpt-5.4", "params"],
        ],
      }),
    ).toEqual({ agents: { defaults: { models: { "openai/gpt-5.4": {} } } } });
  });

  it("applies explicit unsets without mutating caller config", () => {
    const input: OpenClawConfig = {
      gateway: { mode: "local" },
      commands: { ownerDisplay: "hash" },
      tools: { alsoAllow: ["exec", "fetch", "read"] },
    };
    const before = structuredClone(input);
    expect(
      applyUnsetPathsForWrite(input, [
        ["commands", "ownerDisplay"],
        ["tools", "alsoAllow", "1"],
      ]),
    ).toEqual({ gateway: { mode: "local" }, tools: { alsoAllow: ["exec", "read"] } });
    expect(input).toEqual(before);
  });

  it.each([
    ["invalid array suffix", ["tools", "alsoAllow", "1abc"]],
    ["signed array index", ["tools", "alsoAllow", "+0"]],
    ["unsafe integer", ["tools", "alsoAllow", "9007199254740993"]],
    ["maximum array key", ["tools", "alsoAllow", "4294967294"]],
    ["missing key", ["commands", "missingKey"]],
    ["prototype key", ["commands", "__proto__"]],
    ["constructor key", ["commands", "constructor"]],
    ["prototype constructor property", ["commands", "prototype"]],
  ] as const)("treats %s unset paths as immutable no-ops", (_name, unsetPath) => {
    const input: OpenClawConfig = {
      gateway: { mode: "local" },
      commands: { ownerDisplay: "hash" },
      tools: { alsoAllow: ["exec", "fetch"] },
    };
    expect(applyUnsetPathsForWrite(input, [[...unsetPath]])).toBe(input);
  });

  it('formats actionable guidance for dmPolicy="open" without wildcard allowFrom', () => {
    const message = createConfigValidationFailedError([
      {
        path: "channels.telegram.allowFrom",
        message:
          'channels.telegram.dmPolicy = "open" requires channels.telegram.allowFrom to include "*"',
      },
    ]).message;
    expect(message).toContain("openclaw config set channels.telegram.allowFrom '[\"*\"]'");
    expect(message).toContain('openclaw config set channels.telegram.dmPolicy "pairing"');
  });

  it("preserves env refs on unchanged paths while keeping changed paths resolved", () => {
    const unchanged = {
      plugins: { entries: { acme: { config: { env: { API_KEY: "secret" } } } } },
    };
    const before = { ...unchanged, gateway: { port: 18789 } };
    const after = { ...unchanged, gateway: { port: 18789, auth: { mode: "token" } } };
    const changedPaths = new Set<string>();
    collectChangedPaths(before, after, "", changedPaths);
    expect(
      restoreEnvRefsFromMap(
        after,
        "",
        new Map([["plugins.entries.acme.config.env.API_KEY", "${ACME_API_KEY}"]]),
        changedPaths,
      ),
    ).toEqual({
      plugins: { entries: { acme: { config: { env: { API_KEY: "${ACME_API_KEY}" } } } } },
      gateway: { port: 18789, auth: { mode: "token" } },
    });
  });

  it("preserves env refs in arrays while keeping appended entries resolved", () => {
    const config = (args: string[]) => ({ plugins: { entries: { acme: { config: { args } } } } });
    const changedPaths = new Set<string>();
    collectChangedPaths(
      config(["${USER_ID}", "123"]),
      config(["${USER_ID}", "123", "456"]),
      "",
      changedPaths,
    );
    expect(
      restoreEnvRefsFromMap(
        config(["999", "123", "456"]),
        "",
        new Map([["plugins.entries.acme.config.args[0]", "${USER_ID}"]]),
        changedPaths,
      ),
    ).toEqual(config(["${USER_ID}", "123", "456"]));
  });

  it.each([
    {
      name: "does not overwrite identity-restored env refs with positional map entries",
      agents: [
        { id: "b", token: "${TOKEN_B}" },
        { id: "a", token: "${TOKEN_A}" },
      ],
      refs: [
        ["agents[0].token", "${TOKEN_A}"],
        ["agents[1].token", "${TOKEN_B}"],
      ] as const,
    },
    {
      name: "does not overwrite identity-restored escaped refs with positional map entries",
      agents: [
        { id: "real", token: "${TOKEN}" },
        { id: "literal", token: "$${TOKEN}" },
      ],
      refs: [["agents[1].token", "${TOKEN}"]] as const,
    },
  ])("$name", ({ agents, refs }) => {
    expect(
      restoreEnvRefsFromMap(
        { agents },
        "",
        new Map<string, string>(refs),
        new Set(["agents[0].id", "agents[1].id"]),
        new Set(["agents[0].token", "agents[1].token"]),
      ),
    ).toEqual({ agents });
  });

  it("ignores prototype-chain keys when collecting changed paths", () => {
    const base = { safe: { mode: "local" }, collision: { mode: "owned-base" } };
    const target = Object.create({ collision: { mode: "inherited-target" } }) as Record<
      string,
      unknown
    >;
    target.safe = { mode: "cloud" };
    const changedPaths = new Set<string>();
    collectChangedPaths(base, target, "", changedPaths);
    expect([...changedPaths].toSorted()).toEqual(["collision", "safe.mode"]);
  });

  it("restores unchanged paths even when their values equal another authored template", () => {
    expect(
      restoreEnvRefsFromMap(
        {
          included: {
            first: "${SECOND}",
            second: "second-secret",
            third: "$${SECOND}",
            escaped: "$${SECOND}",
          },
          gateway: { port: 18790 },
        },
        "",
        new Map([
          ["included.first", "${FIRST}"],
          ["included.second", "${SECOND}"],
          ["included.third", "${THIRD}"],
          ["included.escaped", "$${SECOND}"],
        ]),
        new Set(["gateway.port"]),
      ),
    ).toEqual({
      included: {
        first: "${FIRST}",
        second: "${SECOND}",
        third: "${THIRD}",
        escaped: "$${SECOND}",
      },
      gateway: { port: 18790 },
    });
  });

  it.each([
    {
      name: "keeps the read-time env snapshot when writing the same config path",
      expectedPath: "/tmp/openclaw.json",
      retained: true,
    },
    {
      name: "drops the read-time env snapshot when writing a different config path",
      expectedPath: "/tmp/other.json",
      retained: false,
    },
  ])("$name", ({ expectedPath, retained }) => {
    const snapshot = { OPENAI_API_KEY: "sk-secret" };
    const actual = resolveWriteEnvSnapshotForPath({
      actualConfigPath: "/tmp/openclaw.json",
      expectedConfigPath: expectedPath,
      envSnapshotForRestore: snapshot,
    });
    if (retained) {
      expect(actual).toBe(snapshot);
    } else {
      expect(actual).toBeUndefined();
    }
  });

  it("keeps runtime-only channel defaults out of the persisted candidate", () => {
    const sourceConfig = {
      gateway: { port: 18789 },
      channels: { imessage: { cliPath: "/usr/local/bin/imsg" } },
    };
    const runtimeConfig = {
      ...sourceConfig,
      channels: { imessage: { cliPath: "/usr/local/bin/imsg", runtimeOnlyDefault: true } },
    };
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig,
        sourceConfig,
        nextConfig: {
          ...structuredClone(runtimeConfig),
          gateway: { port: 18789, auth: { mode: "token" } },
        },
      }),
    ).toEqual({
      gateway: { port: 18789, auth: { mode: "token" } },
      channels: { imessage: { cliPath: "/usr/local/bin/imsg" } },
    });
  });

  it("does not reintroduce legacy nested dm.policy defaults in the persisted candidate", () => {
    const oldChannel = { dmPolicy: "pairing", dm: { enabled: true, policy: "pairing" } };
    const newChannel = { dmPolicy: "pairing", dm: { enabled: true } };
    const sourceConfig = {
      channels: { discord: structuredClone(oldChannel), slack: structuredClone(oldChannel) },
      gateway: { port: 18789 },
    };
    const nextConfig = {
      channels: { discord: structuredClone(newChannel), slack: structuredClone(newChannel) },
      gateway: { port: 18789 },
    };
    expect(
      resolvePersistCandidateForWrite({ runtimeConfig: sourceConfig, sourceConfig, nextConfig }),
    ).toEqual(nextConfig);
  });

  it("preserves normalized nested channel enabled keys during unrelated writes", () => {
    const channels = {
      slack: { channels: { ops: { enabled: false } } },
      googlechat: { groups: { "spaces/aaa": { enabled: true } } },
      discord: { guilds: { "100": { channels: { general: { enabled: false } } } } },
    };
    const sourceConfig = { channels };
    const nextConfig = { ...structuredClone(sourceConfig), gateway: { auth: { mode: "token" } } };
    expect(
      resolvePersistCandidateForWrite({ runtimeConfig: sourceConfig, sourceConfig, nextConfig }),
    ).toEqual(nextConfig);
  });

  it.each([
    {
      name: "allows an explicit local leaf override beside a root include",
      authored: { $include: "./agents.json5" },
      expected: {
        $include: "./agents.json5",
        agents: { defaults: { workspace: "/srv/next" } },
      },
    },
    {
      name: "allows an explicit local leaf override below a nested include",
      authored: { agents: { $include: "./agents.json5" } },
      expected: {
        agents: { $include: "./agents.json5", defaults: { workspace: "/srv/next" } },
      },
    },
  ])("$name", ({ authored, expected }) => {
    const sourceConfig = {
      agents: { defaults: { workspace: "/srv/old" }, entries: { ops: main } },
    };
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig: sourceConfig,
        sourceConfig,
        rootAuthoredConfig: authored,
        nextConfig: sourceConfig,
        explicitSetPaths: [["agents", "defaults", "workspace"]],
        explicitSetValueSource: { agents: { defaults: { workspace: "/srv/next" } } },
        allowIncludeAncestorExplicitSetPaths: true,
      }),
    ).toEqual(expected);
  });

  it.each([
    {
      name: "persists explicitly set keys whose values match runtime defaults",
      paths: [
        ["channels", "telegram", "dmPolicy"],
        ["channels", "telegram", "groupPolicy"],
      ],
    },
    {
      name: "persists default-valued children inside explicitly set objects",
      paths: [["channels", "telegram"]],
    },
  ])("$name", ({ paths }) => {
    const telegram = { botToken: "tok-abc", dmPolicy: "pairing", groupPolicy: "allowlist" };
    const runtimeConfig = { channels: { telegram } };
    const sourceConfig = { channels: { telegram: { botToken: "tok-abc" } } };
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig,
        sourceConfig,
        nextConfig: sourceConfig,
        explicitSetValueSource: runtimeConfig,
        explicitSetPaths: paths,
      }),
    ).toEqual(runtimeConfig);
  });

  it.each([
    {
      name: "persists explicitly set array-index children whose values match runtime defaults",
      paths: [["models", "providers", "openai", "models", "0", "contextWindow"]],
      includesDefault: true,
    },
    {
      name: "ignores unsafe array-index explicit set paths",
      paths: [
        ["models", "providers", "openai", "models", "0abc", "contextWindow"],
        ["models", "providers", "openai", "models", "+0", "contextWindow"],
        ["models", "providers", "openai", "models", "9007199254740993", "contextWindow"],
        ["models", "providers", "openai", "models", "4294967294", "contextWindow"],
      ],
      includesDefault: false,
    },
  ])("$name", ({ paths, includesDefault }) => {
    const withModels = (models: Record<string, unknown>[]) => ({
      models: { providers: { openai: { models } } },
    });
    const sourceConfig = withModels([{ id: "gpt-5.5" }]);
    const runtimeConfig = withModels([{ id: "gpt-5.5", contextWindow: 128000 }]);
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig,
        sourceConfig,
        nextConfig: sourceConfig,
        explicitSetValueSource: runtimeConfig,
        explicitSetPaths: paths,
      }),
    ).toEqual(includesDefault ? runtimeConfig : sourceConfig);
  });

  it("rejects default-valued explicit writes under include-owned paths", () => {
    const sourceConfig = { agents: { defaults: {} } };
    expect(() =>
      resolvePersistCandidateForWrite({
        runtimeConfig: { agents: { defaults: { params: { temperature: 0 } } } },
        sourceConfig,
        rootAuthoredConfig: { agents: { defaults: { $include: "./agents-defaults.json" } } },
        nextConfig: sourceConfig,
        explicitSetValueSource: { agents: { defaults: { params: { temperature: 0 } } } },
        explicitSetPaths: [["agents", "defaults", "params"]],
      }),
    ).toThrow("Config write would flatten $include-owned config at agents.defaults");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
