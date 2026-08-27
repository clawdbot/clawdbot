// Real config CLI coverage for legacy roster input, canonical writes, and ownership.
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it, vi } from "vitest";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { useConfigCliIntegrationHarness } from "./config-cli.integration.test-harness.js";

const cronOwnerRefusal = await import("../config/io.cron-owner-refusal.js");
const {
  registeredRuntimeLogs,
  registeredRuntimeErrors,
  runRegisteredConfigCommand,
  withConfigFileHarness,
} = useConfigCliIntegrationHarness();

describe("config cli roster integration", () => {
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

  it("uses the original numeric roster order when reading a legacy file", async () => {
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
        await runRegisteredConfigCommand([
          "config",
          "set",
          "agents.list[0].name",
          "changed-second",
        ]);
        expect(JSON5.parse(fs.readFileSync(configPath, "utf8")).agents.entries).toEqual({
          "1": { name: "first" },
          "2": { name: "changed-second" },
        });
      },
    );
  });

  it("validates the final replacement instead of a discarded intermediate roster", async () => {
    const raw = JSON.stringify({ agents: { ownership: "explicit", entries: originalEntries } });
    await withConfigFileHarness(
      "openclaw-config-cli-roster-final-replacement-",
      raw,
      async ({ configPath }) => {
        const args = [
          "config",
          "set",
          "--batch-json",
          JSON.stringify([
            { path: "agents.list", value: [{ id: "main" }, { id: "main" }] },
            { path: "agents.entries", value: changedEntries },
          ]),
          "--replace",
        ];
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
          ).rejects.toThrow("__exit__:1");
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
        ).rejects.toThrow("__exit__:1");
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(registeredRuntimeErrors.join("\n")).toContain(error);
        expect(registeredRuntimeLogs.join("\n")).not.toContain("Updated");
      },
    );
  });

  it("previews the same ownership preparation used when adding a second agent", async () => {
    const prepareCronOwner = vi.spyOn(cronOwnerRefusal, "prepareCronOwnerWriteRefusal");
    const raw = `${JSON.stringify({ agents: { entries: { main: { name: "original-main" } } } })}\n`;
    await withConfigFileHarness(
      "openclaw-config-cli-roster-owner-",
      raw,
      async ({ configPath, tempDir }) => {
        const patchFile = path.join(tempDir, "patch.json");
        fs.writeFileSync(
          patchFile,
          JSON.stringify({ agents: { entries: { work: { name: "new-worker" } } } }),
        );
        const args = ["config", "patch", "--file", patchFile];
        await runRegisteredConfigCommand([...args, "--dry-run"]);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(prepareCronOwner).not.toHaveBeenCalled();
        await runRegisteredConfigCommand(args);
        expect(prepareCronOwner).toHaveBeenCalledOnce();
        const after = JSON5.parse(fs.readFileSync(configPath, "utf8"));
        expect(after.agents).toMatchObject({
          ownership: "explicit",
          entries: { main: { name: "original-main" }, work: { name: "new-worker" } },
          defaults: { heartbeat: { agentId: "main" }, systemAgent: { agentId: "main" } },
        });
        expect(after.agents.entries.main.workspace).toEqual(expect.any(String));
      },
    );
  });
});
