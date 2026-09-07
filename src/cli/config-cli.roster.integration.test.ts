// Real config CLI coverage for legacy roster input, canonical writes, and ownership.
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it, vi } from "vitest";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { resolveLegacyInheritedAuthAgentId } from "../agents/legacy-inherited-auth-dir.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { useConfigCliIntegrationHarness } from "./config-cli.integration.test-harness.js";

const cronOwnerRefusal = await import("../config/io.cron-owner-refusal.js");
const {
  registeredRuntimeLogs,
  registeredRuntimeErrors,
  runRegisteredConfigCommand,
  withConfigFileHarness,
} = useConfigCliIntegrationHarness();

describe("config cli roster integration", () => {
  it("validates a surviving SecretRef after its agent is renamed within the batch", async () => {
    const raw = JSON.stringify({
      agents: { entries: { main: {} } },
      secrets: { providers: { default: { source: "env" } } },
    });
    await withConfigFileHarness(
      "openclaw-config-cli-roster-renamed-ref-",
      raw,
      async ({ configPath }) => {
        const envSnapshot = captureEnv(["MISSING_TEST_SECRET"]);
        try {
          deleteTestEnvValue("MISSING_TEST_SECRET");
          await expect(
            runRegisteredConfigCommand([
              "config",
              "set",
              "--batch-json",
              JSON.stringify([
                {
                  path: "agents.list[0].memory.search.remote.apiKey",
                  ref: { source: "env", provider: "default", id: "MISSING_TEST_SECRET" },
                },
                { path: "agents.list[0].id", value: "work" },
                { path: "agents.entries.main", value: {} },
              ]),
              "--dry-run",
              "--json",
            ]),
          ).rejects.toMatchObject({ name: "ExitError", code: 1 });

          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          expect(JSON.parse(registeredRuntimeLogs.join("\n"))).toMatchObject({
            ok: false,
            refsChecked: 1,
            errors: [{ kind: "resolvability", ref: "env:default:MISSING_TEST_SECRET" }],
          });
        } finally {
          envSnapshot.restore();
        }
      },
    );
  });

  const originalEntries = {
    main: { name: "original-main" },
    worker: { name: "original-worker" },
  };
  const changedEntries = { ...originalEntries, main: { name: "changed-main" } };
  const changedList = Object.entries(changedEntries).map(([id, entry]) =>
    Object.assign({ id }, entry),
  );
  const rosterMutations = [
    { name: "indexed set", args: ["set", "agents.list[0].name", "changed-main"] },
    {
      name: "strict indexed set",
      args: ["set", "agents.list[0].name", '"changed-main"', "--strict-json"],
    },
    {
      name: "batch indexed set",
      args: [
        "set",
        "--batch-json",
        JSON.stringify([{ path: "agents.list[0].name", value: "changed-main" }]),
      ],
    },
    {
      name: "whole list set",
      args: ["set", "agents.list", JSON.stringify(changedList), "--strict-json"],
    },
    { name: "whole list patch", patch: { agents: { list: changedList } } },
    {
      name: "indexed unset",
      args: ["unset", "agents.list[0].name"],
      expected: { ...originalEntries, main: {} },
    },
    { name: "canonical control", args: ["set", "agents.entries.main.name", "changed-main"] },
  ];

  it.each(
    rosterMutations.flatMap((mutation) =>
      [false, true].map((legacy) => Object.assign({}, mutation, { legacy })),
    ),
  )(
    "persists roster intent for $name (legacy file: $legacy) after a read-only preview",
    async (mutation) => {
      const agents = {
        ownership: "explicit",
        ...(mutation.legacy
          ? {
              list: Object.entries(originalEntries).map(([id, entry]) =>
                Object.assign({ id }, entry),
              ),
            }
          : { entries: originalEntries }),
      };
      const raw = `${JSON.stringify({ agents })}\n`;
      await withConfigFileHarness(
        "openclaw-config-cli-roster-",
        raw,
        async ({ configPath, tempDir }) => {
          const patchPath = path.join(tempDir, "patch.json");
          const args = mutation.args ?? ["patch", "--file", patchPath];
          if (mutation.patch) {
            fs.writeFileSync(patchPath, JSON.stringify(mutation.patch));
          }
          await runRegisteredConfigCommand(["config", ...args, "--dry-run"]);
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          await runRegisteredConfigCommand(["config", ...args]);
          const after = JSON5.parse(fs.readFileSync(configPath, "utf8"));
          expect(after.agents.entries).toEqual(mutation.expected ?? changedEntries);
          expect(after.agents).not.toHaveProperty("list");
          expect(registeredRuntimeErrors).toEqual([]);
        },
      );
    },
  );

  it("keeps submitted numeric list order through later indexed batch edits", async () => {
    const entries = { "1": { name: "first" }, "2": { name: "second" } };
    const raw = `${JSON.stringify({ agents: { ownership: "explicit", entries } })}\n`;
    await withConfigFileHarness(
      "openclaw-config-cli-roster-order-",
      raw,
      async ({ configPath }) => {
        const args = [
          "config",
          "set",
          "--batch-json",
          JSON.stringify([
            {
              path: "agents.list",
              value: [
                { id: "2", name: "second" },
                { id: "1", name: "first" },
              ],
            },
            { path: "agents.entries.1.name", value: "changed-first" },
            { path: "agents.list[0].name", value: "changed-second" },
          ]),
        ];
        await runRegisteredConfigCommand([...args, "--dry-run"]);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        await runRegisteredConfigCommand(args);
        expect(JSON5.parse(fs.readFileSync(configPath, "utf8")).agents.entries).toEqual({
          "1": { name: "changed-first" },
          "2": { name: "changed-second" },
        });
      },
    );
  });

  it.each(["agents.list[0]", "agents.entries.main"])(
    "preserves authored references during %s edits with equal resolved values",
    async (agentPath) => {
      const raw = JSON.stringify({
        agents: {
          ownership: "explicit",
          entries: {
            main: { workspace: "${ROSTER_WORKSPACE}", skills: ["${ROSTER_SKILL}"] },
            worker: { name: "${ROSTER_NAME}" },
          },
        },
        gateway: { port: 19001 },
      });
      await withConfigFileHarness(
        "openclaw-config-cli-roster-env-",
        raw,
        async ({ configPath, tempDir }) => {
          const envSnapshot = captureEnv(["ROSTER_WORKSPACE", "ROSTER_SKILL", "ROSTER_NAME"]);
          try {
            const workspace = path.join(fs.realpathSync(tempDir), "workspace");
            setTestEnvValue("ROSTER_WORKSPACE", workspace);
            setTestEnvValue("ROSTER_SKILL", "fixture-skill");
            setTestEnvValue("ROSTER_NAME", "untouched");
            const args = [
              "config",
              "set",
              "--batch-json",
              JSON.stringify([
                { path: `${agentPath}.workspace`, value: workspace },
                { path: `${agentPath}.skills[0]`, value: "fixture-skill" },
                { path: `${agentPath}.name`, value: "changed-main" },
                { path: "gateway.port", value: 19002 },
              ]),
            ];
            await runRegisteredConfigCommand([...args, "--dry-run"]);
            expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
            await runRegisteredConfigCommand(args);
            expect(JSON5.parse(fs.readFileSync(configPath, "utf8")).agents.entries).toEqual({
              main: {
                workspace: "${ROSTER_WORKSPACE}",
                skills: ["${ROSTER_SKILL}"],
                name: "changed-main",
              },
              worker: { name: "${ROSTER_NAME}" },
            });
          } finally {
            envSnapshot.restore();
          }
        },
      );
    },
  );

  it.each([
    { name: "leaf recreated", removed: { main: { name: null } }, main: { name: "changed-main" } },
    { name: "entry recreated", removed: { main: null }, main: { name: "changed-main" } },
    { name: "leaf remains deleted", removed: { main: { name: null } }, main: {} },
  ])("honors mixed patch ordering when $name", async ({ removed, main }) => {
    const raw = JSON.stringify({ agents: { ownership: "explicit", entries: originalEntries } });
    await withConfigFileHarness(
      "openclaw-config-cli-roster-patch-order-",
      raw,
      async ({ configPath, tempDir }) => {
        const patchPath = path.join(tempDir, "patch.json");
        fs.writeFileSync(
          patchPath,
          JSON.stringify({
            agents: {
              entries: removed,
              list: [
                { id: "main", ...main },
                { id: "worker", name: "original-worker" },
              ],
            },
          }),
        );
        const args = ["config", "patch", "--file", patchPath];
        await runRegisteredConfigCommand([...args, "--dry-run"]);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        await runRegisteredConfigCommand(args);
        expect(JSON5.parse(fs.readFileSync(configPath, "utf8")).agents.entries).toEqual({
          main,
          worker: originalEntries.worker,
        });
      },
    );
  });

  it.each([
    { name: "retained legacy source", replacement: undefined, editedId: "2" },
    { name: "replaced object parent", replacement: { ownership: "explicit" }, editedId: "1" },
    { name: "replaced null parent", replacement: null, editedId: "1" },
  ])("uses current numeric roster order after $name", async ({ replacement, editedId }) => {
    const entries = { "1": { name: "first" }, "2": { name: "second" } };
    const raw = JSON.stringify({
      agents: {
        ownership: "explicit",
        list: [
          { id: "2", name: "second" },
          { id: "1", name: "first" },
        ],
      },
    });
    await withConfigFileHarness(
      "openclaw-config-cli-roster-source-order-",
      raw,
      async ({ configPath }) => {
        const args =
          replacement === undefined
            ? ["config", "set", "agents.list[0].name", "indexed-change"]
            : [
                "config",
                "set",
                "--batch-json",
                JSON.stringify([
                  { path: "agents", value: replacement },
                  { path: "agents.entries.1", value: entries["1"] },
                  { path: "agents.entries.2", value: entries["2"] },
                  { path: "agents.list[0].name", value: "indexed-change" },
                ]),
                "--replace",
              ];
        await runRegisteredConfigCommand([...args, "--dry-run"]);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        await runRegisteredConfigCommand(args);
        expect(JSON5.parse(fs.readFileSync(configPath, "utf8")).agents.entries).toEqual({
          ...entries,
          [editedId]: { name: "indexed-change" },
        });
      },
    );
  });

  it.each([
    {
      name: "list to keyed",
      operations: [
        { path: "agents.list", value: [{ id: "main" }, { id: "main" }] },
        { path: "agents.entries", value: changedEntries },
      ],
    },
    {
      name: "malformed keyed to list",
      operations: [
        { path: "agents.entries", value: "discarded" },
        { path: "agents.list", value: changedList },
      ],
    },
    {
      name: "keyed identity to list",
      operations: [
        { path: "agents.entries.main.id", value: "main" },
        { path: "agents.list", value: changedList },
      ],
    },
    {
      name: "keyed identity to parent",
      operations: [
        { path: "agents.entries.main.id", value: "main" },
        { path: "agents", value: { ownership: "explicit", list: changedList } },
      ],
    },
    {
      name: "keyed identity to list patch",
      patch: { agents: { entries: { main: { id: "main" } }, list: changedList } },
    },
  ])("validates the final $name replacement instead of a discarded roster", async (scenario) => {
    const raw = JSON.stringify({ agents: { ownership: "explicit", entries: originalEntries } });
    await withConfigFileHarness(
      "openclaw-config-cli-roster-final-replacement-",
      raw,
      async ({ configPath, tempDir }) => {
        const patchPath = path.join(tempDir, "replacement.json");
        if ("patch" in scenario) {
          fs.writeFileSync(patchPath, JSON.stringify(scenario.patch));
        }
        const args =
          "patch" in scenario
            ? ["config", "patch", "--file", patchPath, "--replace-path", "agents.list"]
            : ["config", "set", "--batch-json", JSON.stringify(scenario.operations), "--replace"];
        await runRegisteredConfigCommand([...args, "--dry-run"]);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        await runRegisteredConfigCommand(args);
        expect(JSON5.parse(fs.readFileSync(configPath, "utf8")).agents.entries).toEqual(
          changedEntries,
        );
      },
    );
  });

  it.each(["agents.list[0].model", "agents.entries.main.model"])(
    "validates model references before writing %s",
    async (modelPath) => {
      const raw = JSON.stringify({ agents: { entries: { main: { name: "unchanged" } } } });
      await withConfigFileHarness(
        "openclaw-config-cli-roster-model-",
        raw,
        async ({ configPath }) => {
          await expect(
            runRegisteredConfigCommand([
              "config",
              "set",
              modelPath,
              "missing-roster-provider/missing-model",
            ]),
          ).rejects.toMatchObject({ name: "ExitError", code: 1 });
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          expect(registeredRuntimeErrors.join("\n")).toContain(
            'Cannot set model reference "<configured model reference>" at agents.entries.main.model',
          );
          expect(registeredRuntimeErrors.join("\n")).toContain("openclaw models list");
        },
      );
    },
  );

  it.each([
    {
      name: "removed member",
      list: [{ id: "main", name: "changed-main" }],
      error: "drop agent roster entries",
    },
    { name: "duplicate identity", list: [{ id: "main" }, { id: "main" }], error: "duplicate" },
  ])("does not write a legacy roster with $name", async ({ list, error }) => {
    const raw = JSON.stringify({ agents: { ownership: "explicit", entries: originalEntries } });
    await withConfigFileHarness(
      "openclaw-config-cli-roster-reject-",
      raw,
      async ({ configPath }) => {
        await expect(
          runRegisteredConfigCommand([
            "config",
            "set",
            "agents.list",
            JSON.stringify(list),
            "--replace",
            "--strict-json",
          ]),
        ).rejects.toMatchObject({ name: "ExitError", code: 1 });
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(registeredRuntimeErrors.join("\n")).toContain(error);
        expect(registeredRuntimeLogs.join("\n")).not.toContain("Updated");
      },
    );
  });

  it.each([
    { mode: "canonical patch", ownerId: "main", input: "canonical" },
    { mode: "legacy agents replacement", ownerId: "main", input: "agents" },
    { mode: "legacy list set", ownerId: "keeper", input: "list" },
    { mode: "legacy list patch", ownerId: "keeper", input: "patch" },
    { mode: "batch changes retired default", ownerId: "keeper", input: "batch" },
    { mode: "explicit fleet replacement", ownerId: "keeper", input: "agents", explicitFleet: true },
    { mode: "changed fixed store", ownerId: "keeper", input: "store" },
    {
      mode: "canonical parent copy with a changed store",
      ownerId: "keeper",
      input: "canonical-store",
    },
    { mode: "narrow edit with a changed store", ownerId: "keeper", input: "narrow-store" },
    { mode: "explicit destination store owner", ownerId: "keeper", input: "owned-store" },
  ])("preserves ownership intent through $mode preview and write", async (scenario) => {
    const { ownerId, input } = scenario;
    const explicitFleet = scenario.explicitFleet === true;
    const changedStore = input.endsWith("store");
    const prepareCronOwner = vi.spyOn(cronOwnerRefusal, "prepareCronOwnerWriteRefusal");
    await withConfigFileHarness(
      "openclaw-config-cli-roster-owner-",
      "{}",
      async ({ configPath, tempDir }) => {
        const workspace = path.join(fs.realpathSync(tempDir), "existing-workspace");
        const defaults = {
          workspace,
          ...(explicitFleet || changedStore ? { sessionStore: { agentId: ownerId } } : {}),
          ...(explicitFleet
            ? {
                heartbeat: { agentId: ownerId },
                systemAgent: { agentId: ownerId },
                authInheritance: { agentId: ownerId },
              }
            : {}),
        };
        const ownerEntry = { name: "original-owner", ...(explicitFleet ? { workspace } : {}) };
        const original = {
          agents: {
            defaults,
            ...(explicitFleet ? { ownership: "explicit" } : {}),
            entries: {
              [ownerId]: ownerEntry,
              ...(explicitFleet ? { work: { name: "new-worker" } } : {}),
            },
          },
          session: { store: path.join(fs.realpathSync(tempDir), "sessions.sqlite") },
          channels: { discord: { enabled: true, dmPolicy: "disabled", groupPolicy: "disabled" } },
          ...(explicitFleet
            ? {
                talk: { agentId: ownerId },
                bindings: [{ agentId: ownerId, match: { channel: "discord", accountId: "*" } }],
              }
            : {}),
        };
        const nextStore = changedStore
          ? path.join(fs.realpathSync(tempDir), "destination.sqlite")
          : original.session.store;
        const raw = `${JSON.stringify(original)}\n`;
        fs.writeFileSync(configPath, raw);
        const list = [
          { id: ownerId, ...ownerEntry, default: !explicitFleet && !changedStore },
          {
            id: "work",
            name: "new-worker",
            ...(explicitFleet || changedStore ? { default: true } : {}),
          },
        ];
        const patchFile = path.join(tempDir, "patch.json");
        fs.writeFileSync(
          patchFile,
          JSON.stringify({
            agents:
              input === "canonical" ? { entries: { work: { name: "new-worker" } } } : { list },
          }),
        );
        let args = ["config", "patch", "--file", patchFile];
        if (input === "agents") {
          args = ["config", "set", "agents", JSON.stringify({ defaults, list }), "--strict-json"];
        } else if (input === "list") {
          args = ["config", "set", "agents.list", JSON.stringify(list), "--strict-json"];
        } else if (input === "batch" || changedStore) {
          const operations = changedStore
            ? [
                ...(input === "narrow-store"
                  ? [{ path: "agents.entries.work", value: { name: "new-worker" } }]
                  : [
                      {
                        path: "agents",
                        value:
                          input === "store"
                            ? { defaults, list }
                            : {
                                ownership: "explicit",
                                defaults,
                                entries: { [ownerId]: ownerEntry, work: { name: "new-worker" } },
                              },
                      },
                    ]),
                { path: "session.store", value: nextStore },
                ...(input === "owned-store"
                  ? [{ path: "agents.defaults.sessionStore.agentId", value: "work" }]
                  : []),
              ]
            : [
                { path: "agents.list", value: list },
                { path: `agents.entries.${ownerId}.default`, value: false },
                { path: "agents.entries.work.default", value: true },
              ];
          args = ["config", "set", "--batch-json", JSON.stringify(operations)];
        }
        await runRegisteredConfigCommand([...args, "--dry-run"]);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(prepareCronOwner).not.toHaveBeenCalled();
        await runRegisteredConfigCommand(args);
        expect(prepareCronOwner).toHaveBeenCalledTimes(explicitFleet ? 0 : 1);
        const after = JSON5.parse(fs.readFileSync(configPath, "utf8"));
        expect(after.agents).toMatchObject({
          ownership: "explicit",
          defaults: {
            heartbeat: { agentId: ownerId },
            systemAgent: { agentId: ownerId },
          },
        });
        expect(after.agents.entries).toEqual({
          [ownerId]: { name: "original-owner", workspace },
          work: { name: "new-worker" },
        });
        expect(after.agents).not.toHaveProperty("list");
        expect(after.talk.agentId).toBe(ownerId);
        expect(after.bindings).toEqual([
          { agentId: ownerId, match: { channel: "discord", accountId: "*" } },
        ]);
        const reloaded = await readConfigFileSnapshot();
        expect(reloaded.valid).toBe(true);
        expect(resolveAgentWorkspaceDir(reloaded.config, ownerId)).toBe(workspace);
        expect(resolveAgentWorkspaceDir(reloaded.config, "work")).toBe(
          path.join(workspace, "work"),
        );
        expect(resolveLegacyInheritedAuthAgentId(reloaded.config)).toBe(ownerId);
        expect(after.session.store).toBe(nextStore);
        if (changedStore && input !== "owned-store") {
          expect(after.agents.defaults).not.toHaveProperty("sessionStore.agentId");
        } else {
          const expectedStoreOwner = input === "owned-store" ? "work" : ownerId;
          expect(after.agents.defaults.sessionStore.agentId).toBe(expectedStoreOwner);
          expect(resolveSessionStoreCompatibilityAgentId(reloaded.config)).toBe(expectedStoreOwner);
        }
        expect(registeredRuntimeErrors).toEqual([]);
      },
    );
  });

  it.each([
    {
      name: "duplicate default markers",
      value: {
        list: [
          { id: "main", default: true },
          { id: "work", default: true },
        ],
      },
    },
    {
      name: "non-boolean default marker",
      value: { list: [{ id: "main", default: "yes" }, { id: "work" }] },
    },
    {
      name: "authored explicit ownership with a default marker",
      value: { ownership: "explicit", list: [{ id: "main", default: true }, { id: "work" }] },
    },
    {
      name: "inherited explicit ownership with a default marker",
      sourceAgents: { ownership: "explicit", entries: { main: {}, work: {} } },
      configPath: "agents.list",
      value: [{ id: "main", default: true }, { id: "work" }],
    },
  ])("refuses $name without changing the config", async (scenario) => {
    const raw = JSON.stringify({ agents: scenario.sourceAgents ?? { entries: { main: {} } } });
    await withConfigFileHarness(
      "openclaw-config-cli-roster-invalid-owner-",
      raw,
      async ({ configPath }) => {
        const args = [
          "config",
          "set",
          scenario.configPath ?? "agents",
          JSON.stringify(scenario.value),
          "--replace",
          "--strict-json",
        ];
        for (const preview of [true, false]) {
          await expect(
            runRegisteredConfigCommand([...args, ...(preview ? ["--dry-run", "--json"] : [])]),
          ).rejects.toMatchObject({ name: "ExitError", code: 1 });
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        }
        expect(registeredRuntimeLogs.join("\n")).not.toContain("Updated");
      },
    );
  });
});
