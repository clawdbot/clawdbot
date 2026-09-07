import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgent } from "../agents/agent-create.js";
import { loadAgentTemplateBundle } from "../agents/agent-template-bundle.js";
import { AGENT_TEMPLATE_FILES } from "../agents/agent-template-schema.js";
import { loadAgentTemplate } from "../agents/agent-templates.js";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "../config/config.js";
import {
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePathFromConfig,
  saveCronJobsStore,
} from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { agentsExportCommand, agentsImportCommand } from "./agents.commands.templates.js";
import { createCapturingTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-agent-templates-" });
beforeAll(async () => {
  await tempDirs.setup();
});
afterAll(async () => {
  await tempDirs.cleanup();
});

async function withState(run: (directory: string, configPath: string) => Promise<void>) {
  const directory = await tempDirs.make();
  const configPath = path.join(directory, "openclaw.json");
  await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: directory,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: undefined,
      OPENCLAW_HOME: directory,
    },
    async () => {
      resetConfigRuntimeState();
      try {
        await fs.writeFile(
          configPath,
          JSON.stringify({
            agents: {
              ownership: "explicit",
              entries: {
                ambient: { workspace: path.join(directory, "ambient") },
              },
            },
          }),
        );
        await run(directory, configPath);
      } finally {
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        resetConfigRuntimeState();
      }
    },
  );
}

async function makeBundle(directory: string) {
  const bundle = path.join(directory, "bundle");
  const template = await loadAgentTemplate("researcher");
  await fs.mkdir(path.join(bundle, "workspace"), { recursive: true });
  await fs.writeFile(path.join(bundle, "manifest.json"), JSON.stringify(template.manifest));
  for (const file of AGENT_TEMPLATE_FILES) {
    await fs.writeFile(path.join(bundle, "workspace", file), template.files[file]);
  }
  return { bundle, template };
}

describe("portable agent templates", () => {
  it("round-trips the program and explicit settings, excludes private state, and imports only disabled owned agent turns", async () => {
    await withState(async (directory, configPath) => {
      const workspace = path.join(directory, "source");
      const identity = { name: "Archivist", emoji: "📚", theme: "Careful research" };
      const created = await createAgent({ name: "source", role: "researcher", workspace });
      expect(created.status).toBe("created");
      const snapshot = await readConfigFileSnapshot();
      const initial = snapshot.sourceConfig ?? snapshot.config;
      const entry = initial.agents?.entries?.source;
      expect(entry).toBeDefined();
      Object.assign(entry!, {
        identity,
        description: "Research notes in /opt/research/notes",
        skills: ["notes"],
        model: { primary: "local/research", fallbacks: [] },
        subagents: { allowAgents: ["ambient", "missing"], delegationMode: "prefer" },
      });
      await fs.writeFile(configPath, JSON.stringify(initial));
      resetConfigRuntimeState();
      const program = "# Program\nRead /opt/research/notes and distinguish claims from evidence.\n";
      await fs.writeFile(path.join(workspace, "AGENTS.md"), program);
      await fs.writeFile(path.join(workspace, "USER.md"), "Personal owner biography");
      await fs.writeFile(path.join(workspace, "MEMORY.md"), "Personal long-term memory");
      await fs.mkdir(path.join(workspace, "memory"));
      await fs.writeFile(path.join(workspace, "memory", "today.md"), "Private daily notes");
      if (created.status !== "created") {
        throw new Error("fixture agent not created");
      }
      await fs.mkdir(created.agentDir, { recursive: true });
      await fs.writeFile(path.join(created.agentDir, "auth-profiles.json"), "Private auth fixture");
      await fs.writeFile(path.join(workspace, "BOOTSTRAP.md"), "Private bootstrap");
      const job: CronJob = {
        id: "turn",
        agentId: "source",
        owner: { agentId: "source", accountId: "private-account" },
        name: "Review notes",
        description: "Summarize research",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        pacing: { min: "1m", max: "10m" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Review /opt/research/notes",
          model: "local/research",
          thinking: "low",
          timeoutSeconds: 30,
          allowUnsafeExternalContent: true,
        },
        delivery: { mode: "announce", channel: "last", to: "private-recipient" },
        state: {},
      };
      const jobs: CronJob[] = [
        job,
        { ...job, id: "other-owner", owner: { agentId: "ambient" } },
        { ...job, id: "other-executor", agentId: "ambient" },
        {
          ...job,
          id: "event",
          sessionTarget: "main",
          payload: { kind: "systemEvent", text: "Private event" },
        },
        {
          ...job,
          id: "command",
          payload: { kind: "command", argv: ["echo", "private"], env: { PRIVATE: "fixture" } },
        },
        { ...job, id: "script", payload: { kind: "script", script: "return 1" } },
        { ...job, id: "watcher", schedule: { kind: "on-exit", command: "private executable" } },
      ];
      const storePath = resolveCronJobsStorePathFromConfig(initial);
      await saveCronJobsStore(storePath, { version: 1, jobs });
      const beforeJobs = await loadCronJobsStoreWithConfigJobsReadOnly(storePath);
      const out = path.join(directory, "portable");
      const exported = createCapturingTestRuntime();
      await agentsExportCommand({ id: "source", out, json: true }, exported.runtime);
      expect(JSON.parse(exported.logs.join("\n"))).toMatchObject({
        automations: 1,
        warnings: [
          expect.stringMatching(/^manifest.json:\d+: absolute local path/),
          expect.stringContaining("workspace/AGENTS.md:2: absolute local path"),
          expect.stringMatching(/^automations.json:\d+: absolute local path/),
        ],
        omissions: expect.arrayContaining([
          "USER.md not exported",
          "3 automation(s) skipped: unsupported payload for portable templates",
          "1 automation(s) skipped: executable schedule for portable templates",
        ]),
      });
      expect(await fs.readdir(out)).toEqual(["automations.json", "manifest.json", "workspace"]);
      expect(await fs.readdir(path.join(out, "workspace"))).toEqual([
        "AGENTS.md",
        "IDENTITY.md",
        "SOUL.md",
      ]);
      const automationText = await fs.readFile(path.join(out, "automations.json"), "utf8");
      expect(automationText).not.toMatch(
        /private|allowUnsafeExternalContent|owner|agentId|enabled|delivery/,
      );
      expect((await loadCronJobsStoreWithConfigJobsReadOnly(storePath)).store.jobs).toEqual(
        beforeJobs.store.jobs,
      );
      const destination = path.join(directory, "imported");
      const imported = createCapturingTestRuntime();
      await agentsImportCommand(
        { directory: out, id: "copy", workspace: destination, nonInteractive: true, json: true },
        imported.runtime,
      );
      expect(JSON.parse(imported.logs.join("\n"))).toMatchObject({
        status: "created",
        agentId: "copy",
        warnings: [expect.stringContaining("missing")],
        review: expect.stringContaining("Review before enabling"),
      });
      const next = await readConfigFileSnapshot();
      expect(next.valid).toBe(true);
      expect(next.config.agents?.entries?.copy).toMatchObject({
        identity,
        description: "Research notes in /opt/research/notes",
        skills: ["notes"],
        model: { primary: "local/research", fallbacks: [] },
        subagents: { allowAgents: ["ambient"], delegationMode: "prefer" },
      });
      expect(await fs.readFile(path.join(destination, "AGENTS.md"), "utf8")).toBe(program);
      for (const file of ["SOUL.md", "IDENTITY.md"]) {
        expect(await fs.readFile(path.join(destination, file), "utf8")).toBe(
          await fs.readFile(path.join(workspace, file), "utf8"),
        );
      }
      await expect(fs.access(path.join(destination, "BOOTSTRAP.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const importedJobs = (
        await loadCronJobsStoreWithConfigJobsReadOnly(storePath)
      ).store.jobs.filter((candidate) => candidate.agentId === "copy");
      expect(importedJobs).toHaveLength(1);
      expect(importedJobs[0]).toMatchObject({
        enabled: false,
        agentId: "copy",
        owner: { agentId: "copy" },
        sessionTarget: "isolated",
        delivery: { mode: "none" },
        payload: { kind: "agentTurn", message: "Review /opt/research/notes", timeoutSeconds: 30 },
      });
      expect(importedJobs[0]?.id).not.toBe(job.id);
    });
  });

  it("refuses probable secrets with file and line before replacing an output directory", async () => {
    await withState(async (directory) => {
      const workspace = path.join(directory, "source");
      await createAgent({ name: "source", role: "researcher", workspace });
      const secret = ["sk", "proj", "a".repeat(40)].join("-");
      await fs.writeFile(path.join(workspace, "SOUL.md"), `# Soul\n${secret}\n`);
      const out = path.join(directory, "portable");
      await fs.mkdir(out);
      await fs.writeFile(path.join(out, "keep.txt"), "untouched");
      const failure = agentsExportCommand(
        { id: "source", out, force: true },
        createCapturingTestRuntime().runtime,
      );
      await expect(failure).rejects.toThrow(/workspace\/SOUL.md:2: probable secret/);
      await expect(failure).rejects.not.toThrow(secret);
      expect(await fs.readFile(path.join(out, "keep.txt"), "utf8")).toBe("untouched");
    });
  });

  it("exports only explicit settings and replaces output only with force", async () => {
    await withState(async (directory, configPath) => {
      const snapshot = await readConfigFileSnapshot();
      const cfg = snapshot.sourceConfig ?? snapshot.config;
      await fs.writeFile(
        configPath,
        JSON.stringify({
          ...cfg,
          agents: {
            ...cfg.agents,
            defaults: { skills: ["inherited-skill"], model: "local/inherited" },
          },
        }),
      );
      resetConfigRuntimeState();
      const workspace = path.join(directory, "source");
      await createAgent({ name: "source", role: "researcher", workspace });
      const out = path.join(directory, "portable");
      await fs.mkdir(out);
      await fs.writeFile(path.join(out, "old.txt"), "Prior output");
      const { runtime } = createCapturingTestRuntime();
      await expect(agentsExportCommand({ id: "source", out }, runtime)).rejects.toThrow(
        /not empty/,
      );
      expect(await fs.readFile(path.join(out, "old.txt"), "utf8")).toBe("Prior output");
      await fs.writeFile(path.join(workspace, "SOUL.md"), "Read /opt/research/notes\n");
      const exported = createCapturingTestRuntime();
      await agentsExportCommand({ id: "source", out, force: true }, exported.runtime);
      expect(exported.logs).toContain(
        "Review before sharing: workspace/SOUL.md:1: absolute local path; replace it with a relative path",
      );
      expect(await fs.readdir(out)).toEqual(["manifest.json", "workspace"]);
      const { template } = await loadAgentTemplateBundle(out);
      expect(template.manifest.skills).toBeUndefined();
      expect(template.manifest.model).toBeUndefined();
      expect(template.manifest.role).toBeUndefined();
    });
  });

  it("rejects secrets in decoded JSON before writing an imported agent", async () => {
    await withState(async (directory, configPath) => {
      const { bundle, template } = await makeBundle(directory);
      const before = await fs.readFile(configPath, "utf8");
      const summary = ["sk", "proj", "a".repeat(40)].join("-");
      const serialized = JSON.stringify({ ...template.manifest, summary }).replace(
        "sk-proj",
        "\\u0073k-proj",
      );
      await fs.writeFile(path.join(bundle, "manifest.json"), serialized);
      await expect(
        agentsImportCommand(
          { directory: bundle, id: "copy", nonInteractive: true },
          createCapturingTestRuntime().runtime,
        ),
      ).rejects.toThrow(/probable secret/);
      expect(await fs.readFile(configPath, "utf8")).toBe(before);
    });
  });

  it.each(["../AGENTS.md", "/AGENTS.md", "C:\\AGENTS.md"])(
    "rejects manifest path %s before creating state",
    async (unsafe) => {
      await withState(async (directory, configPath) => {
        const { bundle, template } = await makeBundle(directory);
        await fs.writeFile(
          path.join(bundle, "manifest.json"),
          JSON.stringify({ ...template.manifest, files: [unsafe, "SOUL.md", "IDENTITY.md"] }),
        );
        const before = await fs.readFile(configPath, "utf8");
        await expect(
          agentsImportCommand(
            { directory: bundle, id: "copy", nonInteractive: true },
            createCapturingTestRuntime().runtime,
          ),
        ).rejects.toThrow(/manifest/);
        expect(await fs.readFile(configPath, "utf8")).toBe(before);
      });
    },
  );

  it.each(["symlink", "oversize", "unexpected"])("rejects %s bundle material", async (kind) => {
    const directory = await tempDirs.make();
    const { bundle } = await makeBundle(directory);
    const soul = path.join(bundle, "workspace", "SOUL.md");
    if (kind === "symlink") {
      await fs.unlink(soul);
      await fs.symlink("AGENTS.md", soul);
    } else if (kind === "oversize") {
      await fs.writeFile(soul, "x".repeat(256 * 1024 + 1));
    } else {
      await fs.writeFile(path.join(bundle, "USER.md"), "Personal file");
    }
    await expect(loadAgentTemplateBundle(bundle)).rejects.toThrow(/symlinks|exceeds|Unexpected/);
  });

  it("preserves explicit empty skills and omits delegation when every requested target is missing", async () => {
    await withState(async (directory) => {
      const { bundle, template } = await makeBundle(directory);
      await fs.writeFile(
        path.join(bundle, "manifest.json"),
        JSON.stringify({
          ...template.manifest,
          skills: [],
          subagents: { allowAgents: ["absent", "*"], delegationMode: "suggest" },
        }),
      );
      const { runtime, logs } = createCapturingTestRuntime();
      await agentsImportCommand(
        {
          directory: bundle,
          id: "copy",
          workspace: path.join(directory, "copy"),
          nonInteractive: true,
          json: true,
        },
        runtime,
      );
      const entry = (await readConfigFileSnapshot()).config.agents?.entries?.copy;
      expect(entry?.skills).toEqual([]);
      expect(entry?.model).toBeUndefined();
      expect(entry?.subagents).toEqual({ delegationMode: "suggest" });
      expect(JSON.parse(logs.join("\n")).warnings).toEqual([expect.stringContaining("absent, *")]);
    });
  });

  it("refuses existing ids and nonempty workspaces without modifying config or files", async () => {
    await withState(async (directory, configPath) => {
      const { bundle } = await makeBundle(directory);
      const workspace = path.join(directory, "occupied");
      await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace, "AGENTS.md"), "Existing program");
      const before = await fs.readFile(configPath, "utf8");
      for (const id of ["ambient", "copy"]) {
        await expect(
          agentsImportCommand(
            { directory: bundle, id, workspace, nonInteractive: true },
            createCapturingTestRuntime().runtime,
          ),
        ).rejects.toThrow(/already exists|new or empty/);
      }
      expect(await fs.readFile(configPath, "utf8")).toBe(before);
      expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("Existing program");
    });
  });

  it("rejects an invalid automation before creating the agent or workspace", async () => {
    await withState(async (directory, configPath) => {
      const { bundle } = await makeBundle(directory);
      await fs.writeFile(
        path.join(bundle, "automations.json"),
        JSON.stringify([
          {
            name: "Blank instruction",
            schedule: { kind: "every", everyMs: 60_000 },
            payload: { kind: "agentTurn", message: "   " },
          },
        ]),
      );
      const before = await fs.readFile(configPath, "utf8");
      const workspace = path.join(directory, "copy");
      await expect(
        agentsImportCommand(
          { directory: bundle, id: "copy", workspace, nonInteractive: true },
          createCapturingTestRuntime().runtime,
        ),
      ).rejects.toThrow();
      expect(await fs.readFile(configPath, "utf8")).toBe(before);
      await expect(fs.access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("recognizes an existing case alias as a protected output directory", async (context) => {
    await withState(async (directory) => {
      const workspace = path.join(directory, "source");
      await createAgent({ name: "source", role: "researcher", workspace });
      const alias = path.join(directory, "SOURCE");
      if (!(await fs.stat(alias).catch(() => undefined))) {
        context.skip();
        return;
      }
      await expect(
        agentsExportCommand({ id: "source", out: alias }, createCapturingTestRuntime().runtime),
      ).rejects.toThrow(/overlaps/);
      expect(await fs.readdir(workspace)).toContain("AGENTS.md");
    });
  });

  it.each([
    { reference: "file:///Users/example/project", portable: false },
    { reference: "Path:/Users/example/project", portable: false },
    { reference: "|/Users/example/project|", portable: false },
    { reference: "**/Users/example/project**", portable: false },
    { reference: "«/Users/example/project»", portable: false },
    { reference: "_/Users/example/project_", portable: false },
    { reference: "~~/Users/example/project~~", portable: false },
    { reference: "C://Users/example/project", portable: false },
    { reference: "https://example.org»/Users/example/project", portable: false },
    { reference: "https://example.org,/Users/example/project", portable: false },
    { reference: "_https://example.org_/Users/example/project_", portable: false },
    { reference: "~~https://example.org~~/Users/example/project", portable: false },
    { reference: "https://example.org/docs", portable: true },
    { reference: "https://example.org/#/agent", portable: true },
    { reference: "https://example.org/?next=/docs", portable: true },
    { reference: "./notes/reference.md", portable: true },
    { reference: "notes_/reference.md", portable: true },
    { reference: "https://example.org/%C2%BB/docs", portable: true },
    { reference: "https://example.org/%2C/docs", portable: true },
    { reference: "_https://example.org/docs_", portable: true },
  ])("checks portability of embedded reference $reference", async ({ reference, portable }) => {
    await withState(async (directory) => {
      const workspace = path.join(directory, "source");
      await createAgent({ name: "source", role: "researcher", workspace });
      const content = `Read ${reference}\n`;
      await fs.writeFile(path.join(workspace, "AGENTS.md"), content);
      const out = path.join(directory, "portable");
      const { runtime, logs } = createCapturingTestRuntime();
      await agentsExportCommand({ id: "source", out, json: true }, runtime);
      expect(JSON.parse(logs.join("\n")).warnings).toEqual(
        portable ? [] : [expect.stringContaining("workspace/AGENTS.md:1: absolute local path")],
      );
      expect(await fs.readFile(path.join(out, "workspace", "AGENTS.md"), "utf8")).toBe(content);
    });
  });
});
