import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Doctor cron index tests cover cron doctor checks and repair entrypoints.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCodeModeScriptSyntax } from "../../../agents/code-mode-script-syntax.js";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  loadCronJobsStoreWithConfigJobs,
  loadCronQuarantinedJobs,
  loadCronStore,
  saveCronQuarantinedJobs,
  saveCronStore,
} from "../../../cron/store.js";
import { cronStoreKey } from "../../../cron/store/key.js";
import { readCronTaskRunHistoryPage } from "../../../cron/task-run-history.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { withRestoredMocks } from "../../../test-utils/vitest-spies.js";
import {
  collectLegacyCronStoreHealthFindings,
  collectLegacyWhatsAppCrontabHealthWarning,
  maybeRepairLegacyCronStore,
  noteLegacyWhatsAppCrontabHealthCheck,
} from "./index.js";

type TerminalNote = (message: string, title?: string) => void;

const noteMock = vi.hoisted(() => vi.fn<TerminalNote>());

vi.mock("../../../../packages/terminal-core/src/note.js", () => ({
  note: noteMock,
}));

let tempRoot: string | null = null;

async function makeTempStorePath() {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-cron-"));
  return path.join(tempRoot, "cron", "jobs.json");
}

function resolveLegacyCronQuarantinePath(storePath: string): string {
  return storePath.replace(/\.json$/, "-quarantine.json");
}

afterEach(async () => {
  vi.unstubAllEnvs();
  noteMock.mockClear();
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function makePrompter(confirmResult = true) {
  return {
    confirm: vi.fn().mockResolvedValue(confirmResult),
  };
}

function createCronConfig(
  storePath: string,
  webhook = "https://example.invalid/cron-finished",
): OpenClawConfig {
  return {
    cron: {
      store: storePath,
      webhook,
    },
  } as unknown as OpenClawConfig;
}

function createLegacyCronJob(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "legacy-job",
    name: "Legacy job",
    notify: true,
    createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
    schedule: { kind: "cron", cron: "0 7 * * *", tz: "UTC" },
    payload: {
      kind: "systemEvent",
      text: "Morning brief",
    },
    state: {},
    ...overrides,
  };
}

function createCurrentCronJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "sqlite-job",
    name: "SQLite job",
    enabled: true,
    createdAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "systemEvent",
      text: "SQLite brief",
    },
    state: {},
    ...overrides,
  };
}

async function writeCronStore(storePath: string, jobs: Array<Record<string, unknown>>) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        version: 1,
        jobs,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function writeCurrentCronStore(storePath: string, jobs: Array<Record<string, unknown>>) {
  await saveCronStore(storePath, {
    version: 1,
    jobs: jobs as never,
  });
}

async function writeLegacyCronArrayStore(storePath: string, jobs: Array<Record<string, unknown>>) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(jobs, null, 2), "utf-8");
}

async function readPersistedJobs(storePath: string): Promise<Array<Record<string, unknown>>> {
  return (await loadCronStore(storePath)).jobs as unknown as Array<Record<string, unknown>>;
}

function requirePersistedJob(jobs: Array<Record<string, unknown>>, index: number) {
  const job = jobs[index];
  if (!job) {
    throw new Error(`expected persisted cron job ${index}`);
  }
  return job;
}

const requireRecord = createRequireRecord("record", "expected-label");

function expectNoteContaining(message: string, title: string): void {
  expect(
    noteMock.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes(message) && call[1] === title,
    ),
  ).toBe(true);
}

function expectNoNoteContaining(message: string, title: string): void {
  expect(
    noteMock.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes(message) && call[1] === title,
    ),
  ).toBe(false);
}

function createFsError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function mockExdevRename(filePath: string) {
  const realRename = fs.rename.bind(fs);
  return vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
    if (oldPath === filePath) {
      throw createFsError("EXDEV", "cross-device link not permitted, rename");
    }
    return await realRename(oldPath, newPath);
  });
}

describe("collectLegacyCronStoreHealthFindings", () => {
  it("reports alias-only Gateway exec jobs with recreation guidance", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [
      createCurrentCronJob({
        id: "legacy-gateway-exec",
        name: "Legacy gateway shell",
        scheduledToolPolicy: { version: 1, mode: "trusted" },
        payload: {
          kind: "agentTurn",
          message: "run",
          toolsAllow: ["gateway_exec"],
        },
      }),
    ]);

    const findings = await collectLegacyCronStoreHealthFindings({
      cfg: createCronConfig(storePath),
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requirement: "legacy-gateway-exec-recreation",
          message: expect.stringContaining("retired `gateway_exec` alias"),
          fixHint: expect.stringContaining("fresh authenticated creator turn"),
        }),
      ]),
    );
    expect((await readPersistedJobs(storePath))[0]?.payload).toMatchObject({
      toolsAllow: ["gateway_exec"],
    });
  });

  it("reports legacy cron store, run-log, and payload findings without mutating files", async () => {
    const storePath = await makeTempStorePath();
    await writeLegacyCronArrayStore(storePath, [
      createLegacyCronJob({
        jobId: "legacy-notify",
        payload: {
          kind: "systemEvent",
          text: "Morning brief",
        },
      }),
    ]);
    const runLogPath = path.join(path.dirname(storePath), "runs", "legacy-notify.jsonl");
    await fs.mkdir(path.dirname(runLogPath), { recursive: true });
    await fs.writeFile(runLogPath, "", "utf-8");

    const findings = await collectLegacyCronStoreHealthFindings({
      cfg: createCronConfig(storePath),
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "core/doctor/legacy-cron-store",
          severity: "warning",
          path: storePath,
          requirement: "legacy-cron-store",
        }),
        expect.objectContaining({
          checkId: "core/doctor/legacy-cron-store",
          severity: "warning",
          path: resolveOpenClawStateSqlitePath(),
          requirement: "legacy-notify-fallback",
        }),
      ]),
    );
    expect(findings.some((finding) => finding.requirement === "legacy-cron-run-logs")).toBe(true);
    await expect(fs.readFile(storePath, "utf-8")).resolves.toContain("legacy-notify");
    await expect(fs.stat(runLogPath)).resolves.toBeDefined();
  });

  it("reports quarantined cron rows while leaving the active store untouched", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, []);
    saveCronQuarantinedJobs({
      storePath,
      nowMs: Date.parse("2026-05-29T09:00:00.000Z"),
      entries: [
        {
          sourceIndex: 1,
          reason: "missing-schedule",
          job: { id: "bad-cron", name: "Bad cron" },
        },
      ],
    });

    const findings = await collectLegacyCronStoreHealthFindings({
      cfg: createCronConfig(storePath),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/legacy-cron-store",
        path: resolveOpenClawStateSqlitePath(),
        requirement: "quarantined-cron-rows",
      }),
    ]);
    await expect(readPersistedJobs(storePath)).resolves.toEqual([]);
  });

  it("attributes SQLite-only cron findings to the canonical state database", async () => {
    const storePath = await makeTempStorePath();
    vi.stubEnv("OPENCLAW_STATE_DIR", path.dirname(path.dirname(storePath)));
    await writeCurrentCronStore(storePath, [createCurrentCronJob({ notify: true })]);

    const findings = await collectLegacyCronStoreHealthFindings({ cfg: {} });

    expect(findings).toEqual([
      expect.objectContaining({
        path: resolveOpenClawStateSqlitePath(),
        requirement: "legacy-notify-fallback",
      }),
    ]);
  });

  it("returns no findings for an already-normalized empty cron store", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, []);

    await expect(
      collectLegacyCronStoreHealthFindings({ cfg: createCronConfig(storePath) }),
    ).resolves.toEqual([]);
  });

  it("includes disabled authority debt in the remediation inventory", async () => {
    const storePath = await makeTempStorePath();
    const legacyAuthorityJob = {
      owner: { agentId: "main", sessionKey: "agent:main:discord:group:ops" },
      payload: { kind: "agentTurn", message: "run", toolsAllow: ["write"] },
    };
    await writeCurrentCronStore(storePath, [
      createCurrentCronJob({
        ...legacyAuthorityJob,
        id: "legacy-authority-enabled",
        name: "Enabled authority debt",
      }),
      createCurrentCronJob({
        ...legacyAuthorityJob,
        id: "legacy-authority-disabled",
        name: "Disabled authority debt",
        enabled: false,
      }),
    ]);

    const findings = await collectLegacyCronStoreHealthFindings({
      cfg: createCronConfig(storePath),
    });
    const finding = findings.find(
      ({ requirement }) => requirement === "cron-scheduled-authority-reauthorization",
    );

    expect(finding).toEqual(
      expect.objectContaining({
        message: "2 tool-bearing automations require explicit scheduled authority reauthorization.",
        fixHint: expect.stringContaining("openclaw automations list --all"),
      }),
    );
  });

  it("reports a legacy quarantine sidecar without creating or modifying a SQLite database", async () => {
    const storePath = await makeTempStorePath();
    vi.stubEnv("OPENCLAW_STATE_DIR", path.dirname(path.dirname(storePath)));
    const quarantinePath = resolveLegacyCronQuarantinePath(storePath);
    await fs.mkdir(path.dirname(quarantinePath), { recursive: true });
    const historicalBytes = JSON.stringify({
      version: 1,
      jobs: [{ quarantinedAtMs: 123, sourceIndex: 0, reason: "invalid-schedule", raw: null }],
    });
    await fs.writeFile(quarantinePath, historicalBytes, "utf-8");

    const findings = await collectLegacyCronStoreHealthFindings({
      cfg: createCronConfig(storePath),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        path: quarantinePath,
        requirement: "legacy-cron-quarantine",
      }),
    ]);
    await expect(fs.readFile(quarantinePath, "utf-8")).resolves.toBe(historicalBytes);
    await expect(fs.stat(resolveOpenClawStateSqlitePath())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("maybeRepairLegacyCronStore", () => {
  it("detects, repairs, reloads, and idempotently migrates the stable documented SQLite trigger script", async () => {
    const storePath = await makeTempStorePath();
    const stableScript =
      "const res = await tools.call('exec', { command: 'gh pr checks 123 --json state -q \\'.[].state\\' | sort -u' }); const status = String(res?.result?.details?.aggregated ?? '').trim(); json({ fire: status !== trigger.state?.status, message: `PR 123 CI: ${trigger.state?.status ?? 'unknown'} -> ${status}`, state: { status } });";
    const ignoredResultScript =
      "// Preserve the trigger comment.\nawait tools.call(\"exec\", { command: 'echo done' });";
    const betaOnlyPayloadScript =
      "await tools.call('exec', { command: 'leave payload unchanged' })";
    await writeCurrentCronStore(storePath, [
      createCurrentCronJob({
        id: "stable-pr-watcher",
        name: "Stable PR watcher",
        schedule: { kind: "every", everyMs: 30_000 },
        trigger: { script: stableScript, once: false },
      }),
      createCurrentCronJob({
        id: "ignored-result",
        name: "Ignored result watcher",
        trigger: { script: ignoredResultScript },
      }),
      createCurrentCronJob({
        id: "beta-script-payload",
        name: "Beta-only script payload",
        payload: { kind: "script", script: betaOnlyPayloadScript },
      }),
    ]);
    const cfg = createCronConfig(storePath);

    expect(await collectLegacyCronStoreHealthFindings({ cfg })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requirement: "legacy-cron-trigger-script",
          message: expect.stringContaining("Stable PR watcher"),
        }),
        expect.objectContaining({
          requirement: "legacy-cron-trigger-script",
          message: expect.stringContaining("Ignored result watcher"),
        }),
      ]),
    );
    expect(
      requireRecord(requirePersistedJob(await readPersistedJobs(storePath), 0).trigger, "trigger")
        .script,
    ).toBe(stableScript);

    const declinePrompter = makePrompter(false);
    await maybeRepairLegacyCronStore({ cfg, options: {}, prompter: declinePrompter });
    expect(declinePrompter.confirm).toHaveBeenCalledTimes(1);
    expectNoteContaining("Stable PR watcher", "Cron");
    expect(
      requireRecord(requirePersistedJob(await readPersistedJobs(storePath), 0).trigger, "trigger")
        .script,
    ).toBe(stableScript);

    noteMock.mockClear();
    const fixPrompter = makePrompter(true);
    await maybeRepairLegacyCronStore({ cfg, options: { repair: true }, prompter: fixPrompter });

    const expectedScript = stableScript
      .replace("tools.call('exec', ", "exec(")
      .replace("res?.result?.details", "res");
    const reloaded = await loadCronJobsStoreWithConfigJobs(storePath);
    expect(reloaded.store.jobs[0]?.trigger?.script).toBe(expectedScript);
    expect(reloaded.store.jobs[1]?.trigger?.script).toBe(
      "// Preserve the trigger comment.\nawait exec({ command: 'echo done' });",
    );
    expect(reloaded.store.jobs[2]?.payload).toMatchObject({
      kind: "script",
      script: betaOnlyPayloadScript,
    });
    expect(requireRecord(reloaded.configJobs[0]?.trigger, "trigger").script).toBe(expectedScript);
    expect(parseCodeModeScriptSyntax(expectedScript).ok).toBe(true);
    expect(fsSync.existsSync(storePath)).toBe(false);
    expectNoteContaining("Stable PR watcher", "Doctor changes");
    expectNoteContaining("2 legacy cron trigger scripts", "Doctor changes");

    noteMock.mockClear();
    const secondPrompter = makePrompter(true);
    await maybeRepairLegacyCronStore({ cfg, options: { repair: true }, prompter: secondPrompter });
    expect(secondPrompter.confirm).not.toHaveBeenCalled();
    expectNoNoteContaining("legacy trigger script", "Cron");
    expect(
      requireRecord(requirePersistedJob(await readPersistedJobs(storePath), 0).trigger, "trigger")
        .script,
    ).toBe(expectedScript);
  });

  it("leaves unsupported legacy trigger scripts untouched and reports redacted per-job remediation", async () => {
    const storePath = await makeTempStorePath();
    const unsupportedScripts = [
      { id: "dynamic-name", script: "await tools.call(toolName, { command: 'secret-token' })" },
      { id: "dynamic-args", script: "await tools.call('exec', args)" },
      {
        id: "mixed-legacy",
        script:
          "const res = await tools.call('exec', { command: 'secret-token' }); tools.search('x')",
      },
      {
        id: "envelope-result",
        script: "const res = await tools.call('exec', { command: 'x' }); json(res.result)",
      },
      {
        id: "envelope-tool",
        script: "const res = await tools.call('exec', { command: 'x' }); json(res.tool)",
      },
      {
        id: "destructured",
        script: "const { result } = await tools.call('exec', { command: 'x' }); json(result)",
      },
      {
        id: "reassigned",
        script:
          "let res = await tools.call('exec', { command: 'x' }); res = other; json(res.result.details)",
      },
      {
        id: "shadowed",
        script: "const tools = localTools; await tools.call('exec', { command: 'x' })",
      },
      { id: "catalog", script: "json(ALL_TOOLS)" },
      { id: "global-tools", script: "await globalThis.tools.call('exec', { command: 'x' })" },
      { id: "global-catalog", script: "json(globalThis.ALL_TOOLS)" },
      { id: "computed-global-tools", script: 'json(globalThis["tools"])' },
      { id: "top-level-this-tools", script: "json(this.tools)" },
      { id: "describe", script: "json(await tools.describe('exec'))" },
      { id: "safe-name", script: "await tools.exec({ command: 'x' })" },
      { id: "computed-callee", script: "await tools['call']('exec', { command: 'x' })" },
      { id: "spread-args", script: "await tools.call('exec', { ...args })" },
      { id: "computed-args", script: "await tools.call('exec', { [key]: 'x' })" },
      {
        id: "commented-call",
        script: "await tools.call('exec', /* preserve this */ { command: 'x' })",
      },
      {
        id: "commented-envelope",
        script:
          "const res = await tools.call('exec', { command: 'x' }); json(res.result /* preserve this */ .details)",
      },
      {
        id: "aliased-result",
        script: "const res = await tools.call('exec', { command: 'x' }); const alias = res",
      },
      {
        id: "shadowed-exec",
        script: "const exec = localExec; await tools.call('exec', { command: 'x' })",
      },
      {
        id: "ambiguous-scope",
        script:
          "const res = await tools.call('exec', { command: 'x' }); function inspect() { return res.result.details }",
      },
    ];
    await writeCurrentCronStore(
      storePath,
      unsupportedScripts.map(({ id, script }) =>
        createCurrentCronJob({ id, name: `Legacy ${id}`, trigger: { script } }),
      ),
    );
    const cfg = createCronConfig(storePath);

    const findings = await collectLegacyCronStoreHealthFindings({ cfg });
    for (const { id } of unsupportedScripts) {
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requirement: "unsupported-legacy-cron-trigger-script",
            message: expect.stringContaining(`Legacy ${id}`),
          }),
        ]),
      );
    }

    const prompter = makePrompter(true);
    await maybeRepairLegacyCronStore({ cfg, options: { repair: true }, prompter });

    expect(prompter.confirm).not.toHaveBeenCalled();
    for (const { id } of unsupportedScripts) {
      expectNoteContaining(`Legacy ${id}`, "Cron");
    }
    expectNoteContaining("manually", "Cron");
    expectNoNoteContaining("secret-token", "Cron");
    expect(
      (await readPersistedJobs(storePath)).map((job) => ({
        id: job.id,
        script: requireRecord(job.trigger, "trigger").script,
      })),
    ).toEqual(unsupportedScripts);
  });

  it("keeps shared-workspace legacy MCP warnings scoped to each job agent", async () => {
    const storePath = await makeTempStorePath();
    const sharedWorkspace = path.join(path.dirname(storePath), "shared-workspace");
    await writeCurrentCronStore(storePath, [
      createCurrentCronJob({
        id: "research-job",
        name: "Research legacy cap",
        agentId: "research",
        payload: {
          kind: "agentTurn",
          message: "research",
          toolsAllow: ["read"],
          toolsAllowIsDefault: true,
        },
      }),
      createCurrentCronJob({
        id: "support-job",
        name: "Support legacy cap",
        agentId: "support",
        payload: {
          kind: "agentTurn",
          message: "support",
          toolsAllow: ["read"],
          toolsAllowIsDefault: true,
        },
      }),
    ]);
    const cfg = {
      cron: { store: storePath },
      agents: {
        list: [
          { id: "research", workspace: sharedWorkspace },
          { id: "support", workspace: sharedWorkspace },
        ],
      },
      mcp: {
        servers: {
          notes: {
            transport: "stdio",
            command: "notes-mcp",
            codex: { agents: ["research"] },
          },
        },
      },
    } as OpenClawConfig;

    await maybeRepairLegacyCronStore({
      cfg,
      options: {},
      prompter: makePrompter(true),
    });

    const advisory = noteMock.mock.calls.find(
      ([message, title]) =>
        title === "Cron" &&
        typeof message === "string" &&
        message.includes("inherited default tool cap"),
    )?.[0];
    expect(advisory).toContain("Research legacy cap");
    expect(advisory).not.toContain("Support legacy cap");
  });

  it("uses the system agent for agent-less legacy-cap diagnostics", async () => {
    const storePath = await makeTempStorePath();
    const mainWorkspace = path.join(path.dirname(storePath), "main-workspace");
    await writeCurrentCronStore(storePath, [
      createCurrentCronJob({
        id: "ambient-job",
        name: "Ambient legacy cap",
        payload: {
          kind: "agentTurn",
          message: "ambient",
          toolsAllow: ["read"],
          toolsAllowIsDefault: true,
        },
      }),
    ]);
    const cfg = {
      cron: { store: storePath },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { workspace: mainWorkspace },
          helper: {},
          third: {},
        },
      },
      mcp: {
        servers: {
          notes: {
            transport: "stdio",
            command: "notes-mcp",
            codex: { agents: ["main"] },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      maybeRepairLegacyCronStore({ cfg, options: {}, prompter: makePrompter(true) }),
    ).resolves.toBeUndefined();

    const advisory = noteMock.mock.calls.find(
      ([message, title]) =>
        title === "Cron" &&
        typeof message === "string" &&
        message.includes("inherited default tool cap"),
    )?.[0];
    expect(advisory).toContain("Ambient legacy cap");
  });

  it("reports quarantined cron rows even when the active store is already sanitized", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, []);
    saveCronQuarantinedJobs({
      storePath,
      nowMs: Date.parse("2026-05-29T09:00:00.000Z"),
      entries: [
        {
          sourceIndex: 1,
          reason: "missing-schedule",
          job: { id: "bad-cron", name: "Bad cron" },
        },
      ],
    });

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    expectNoteContaining("Quarantined cron job rows found", "Cron");
    expectNoteContaining("1 row was removed from the active cron store", "Cron");
  });

  it("imports and archives standalone legacy quarantine files without losing recovery fields", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, []);
    const quarantinePath = resolveLegacyCronQuarantinePath(storePath);
    await fs.mkdir(path.dirname(quarantinePath), { recursive: true });
    const historicalJob = {
      quarantinedAtMs: Date.parse("2026-05-29T09:00:00.000Z"),
      sourceIndex: 7,
      reason: "invalid-schedule",
      job: { id: "historical-bad-cron", name: "Historical bad cron" },
      raw: { observed: true },
      state: { nextRunAtMs: 456 },
      updatedAtMs: 789,
      scheduleIdentity: "historical-schedule",
    };
    await fs.writeFile(quarantinePath, JSON.stringify({ version: 1, jobs: [historicalJob] }));
    const prompter = makePrompter(true);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter,
    });

    expect(loadCronQuarantinedJobs(storePath)).toEqual([historicalJob]);
    await expect(fs.stat(quarantinePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${quarantinePath}.migrated`)).resolves.toBeDefined();
    expect(prompter.confirm).toHaveBeenCalledTimes(1);
    expectNoteContaining("Cron quarantine migrated to SQLite", "Doctor changes");
  });

  it("deduplicates migrated quarantine records when sidecar archival must be retried", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, []);
    const quarantinePath = resolveLegacyCronQuarantinePath(storePath);
    await fs.mkdir(path.dirname(quarantinePath), { recursive: true });
    const historicalJob = {
      quarantinedAtMs: 123,
      sourceIndex: 0,
      reason: "invalid-schedule",
      job: { id: "retry-bad-cron" },
    };
    await fs.writeFile(quarantinePath, JSON.stringify({ version: 1, jobs: [historicalJob] }));
    const rename = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(createFsError("EACCES", "archive unavailable"));

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    expect(loadCronQuarantinedJobs(storePath)).toEqual([historicalJob]);
    await expect(fs.stat(quarantinePath)).resolves.toBeDefined();
    expectNoteContaining("could not archive the legacy cron file", "Doctor warnings");
    rename.mockRestore();

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    expect(loadCronQuarantinedJobs(storePath)).toEqual([historicalJob]);
    await expect(fs.stat(`${quarantinePath}.migrated`)).resolves.toBeDefined();
  });

  it("surfaces cron payload model overrides without rewriting current jobs", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [
      {
        id: "api-pinned",
        name: "API pinned",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 7 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
          model: "openai/gpt-5.4",
          thinking: "high",
        },
        state: {},
      },
      {
        id: "other-pinned",
        name: "Other pinned",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
          model: "anthropic/claude-sonnet-4-6",
        },
        state: {},
      },
      {
        id: "inherits-default",
        name: "Inherits default",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
        },
        state: {},
      },
      createCurrentCronJob({
        id: "disabled-pinned",
        enabled: false,
        payload: { kind: "agentTurn", message: "Dormant job", model: "ollama/qwen3" },
      }),
    ]);
    const prompter = makePrompter(true);

    await maybeRepairLegacyCronStore({
      cfg: {
        cron: { store: storePath },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5", fallbacks: [] },
          },
        },
      } as unknown as OpenClawConfig,
      options: {},
      prompter,
    });

    expect(prompter.confirm).not.toHaveBeenCalled();
    expectNoteContaining("Automation model overrides detected", "Cron");
    expectNoteContaining("2 jobs set `payload.model`", "Cron");
    expectNoteContaining("Provider namespaces: anthropic=1, openai=1", "Cron");
    expectNoteContaining("2 jobs use a different model than `agents.defaults.model`", "Cron");
    expectNoNoteContaining("ollama", "Cron");
    expectNoNoteContaining("jobs.json", "Cron");

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    const payload = requireRecord(job.payload, "cron payload");
    expect(payload.model).toBe("openai/gpt-5.4");
    expect(payload.thinking).toBe("high");
  });

  it("does not surface cron model override diagnostics when jobs inherit the default", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [
      {
        id: "inherits-default",
        name: "Inherits default",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
        },
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    expectNoNoteContaining("Automation model overrides detected", "Cron");
  });

  it("counts alias model pins as default mismatches", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [
      {
        id: "alias-pinned",
        name: "Alias the native runtime",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 10 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
          model: "gpt",
        },
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: {
        cron: { store: storePath },
        agents: {
          defaults: {
            model: { primary: "test:opus", fallbacks: [] },
          },
        },
      } as unknown as OpenClawConfig,
      options: {},
      prompter: makePrompter(true),
    });

    expectNoteContaining("1 job set `payload.model`", "Cron");
    expectNoteContaining("Provider namespaces: bare/alias=1", "Cron");
    expectNoteContaining("1 job uses a different model than `agents.defaults.model`", "Cron");
    expectNoteContaining("Examples: alias-pinned -> gpt", "Cron");
  });

  describe("in-flight cron job advisory", () => {
    const RUNNING_AT_MS = Date.parse("2026-05-01T00:00:00.000Z");

    it("warns about disabled jobs still marked in-flight without hiding the inventory", async () => {
      const storePath = await makeTempStorePath();
      await writeCurrentCronStore(storePath, [
        createCurrentCronJob({
          id: "running-job",
          enabled: false,
          state: { runningAtMs: RUNNING_AT_MS },
        }),
      ]);
      const prompter = makePrompter(true);

      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter,
      });

      expectNoteContaining("1 automation is still marked in-flight", "Cron");
      expectNoNoteContaining("shows it as `running`", "Cron");
      expectNoteContaining("marks such runs interrupted the next time it starts", "Cron");
      expectNoteContaining("openclaw automations list --all", "Cron");
      expectNoteContaining("openclaw automations show <id>", "Cron");

      // Observer-only: no repair prompt and the running marker is left untouched.
      expect(prompter.confirm).not.toHaveBeenCalled();
      const jobs = await readPersistedJobs(storePath);
      const state = requireRecord(requirePersistedJob(jobs, 0).state, "cron state");
      expect(state.runningAtMs).toBe(RUNNING_AT_MS);
      expect(state.lastRunStatus).toBeUndefined();
    });

    it("pluralizes the advisory when multiple jobs are in-flight", async () => {
      const storePath = await makeTempStorePath();
      await writeCurrentCronStore(storePath, [
        createCurrentCronJob({ id: "running-a", state: { runningAtMs: RUNNING_AT_MS } }),
        createCurrentCronJob({ id: "running-b", state: { runningAtMs: RUNNING_AT_MS + 1000 } }),
      ]);

      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      expectNoteContaining("2 automations are still marked in-flight", "Cron");
      expectNoteContaining("openclaw automations list --all", "Cron");
    });

    it("stays silent when no job is marked in-flight", async () => {
      const storePath = await makeTempStorePath();
      await writeCurrentCronStore(storePath, [createCurrentCronJob({ id: "idle-job" })]);

      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      expectNoNoteContaining("still marked in-flight", "Cron");
    });
  });

  describe("chronic failure advisory", () => {
    it("warns about repeatedly failing jobs without touching the store", async () => {
      const storePath = await makeTempStorePath();
      await writeCurrentCronStore(storePath, [
        createCurrentCronJob({
          id: "failing-job",
          state: { lastRunStatus: "error", consecutiveErrors: 5, lastError: "boom" },
        }),
      ]);
      const prompter = makePrompter(true);

      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter,
      });

      expectNoteContaining("1 automation has failed 3+ runs in a row", "Cron");
      expectNoteContaining("re-fires it on error backoff", "Cron");
      expectNoteContaining("resets on the next successful run", "Cron");
      expectNoteContaining("interrupted by a gateway restart", "Cron");
      expectNoteContaining("openclaw automations show <id>", "Cron");

      // Observer-only: no repair prompt and the failure counters stay untouched.
      expect(prompter.confirm).not.toHaveBeenCalled();
      const jobs = await readPersistedJobs(storePath);
      const state = requireRecord(requirePersistedJob(jobs, 0).state, "cron state");
      expect(state.consecutiveErrors).toBe(5);
    });

    it("pluralizes and only counts enabled jobs at or above the threshold", async () => {
      const storePath = await makeTempStorePath();
      await writeCurrentCronStore(storePath, [
        createCurrentCronJob({
          id: "failing-a",
          state: { lastRunStatus: "error", consecutiveErrors: 3 },
        }),
        createCurrentCronJob({
          id: "failing-b",
          state: { lastRunStatus: "error", consecutiveErrors: 12 },
        }),
        createCurrentCronJob({
          id: "recovering",
          state: { lastRunStatus: "error", consecutiveErrors: 2 },
        }),
        // Exhausted one-shot jobs get disabled with their error state retained;
        // they no longer re-fire, so the advisory must not count them.
        createCurrentCronJob({
          id: "disabled-exhausted",
          enabled: false,
          state: { lastRunStatus: "error", consecutiveErrors: 9 },
        }),
      ]);

      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      expectNoteContaining("2 automations have failed 3+ runs in a row", "Cron");
    });

    it("stays silent when failure streaks are below the threshold", async () => {
      const storePath = await makeTempStorePath();
      await writeCurrentCronStore(storePath, [
        createCurrentCronJob({
          id: "single-failure",
          state: { lastRunStatus: "error", consecutiveErrors: 2 },
        }),
      ]);

      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      expectNoNoteContaining("runs in a row", "Cron");
    });

    it("lists auto-disabled jobs with their recorded reasons and recovery commands", async () => {
      const storePath = await makeTempStorePath();
      await writeCurrentCronStore(storePath, [
        createCurrentCronJob({
          id: "run-failure-job",
          name: "Run failure job",
          enabled: false,
          state: {
            consecutiveErrors: 10,
            autoDisabled: {
              reason: "consecutive-failures",
              atMs: Date.parse("2026-08-01T10:00:00.000Z"),
              consecutiveErrors: 10,
            },
          },
        }),
        createCurrentCronJob({
          id: "schedule-error-job",
          name: "Schedule error job",
          enabled: false,
          state: {
            scheduleErrorCount: 3,
            autoDisabled: {
              reason: "schedule-errors",
              atMs: Date.parse("2026-08-01T11:00:00.000Z"),
              consecutiveErrors: 3,
            },
          },
        }),
        createCurrentCronJob({
          id: "disabled-one-shot",
          enabled: false,
          state: { lastRunStatus: "error", consecutiveErrors: 9 },
        }),
      ]);

      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      expectNoteContaining("2 automations are auto-disabled", "Cron");
      expectNoteContaining("Run failure job (run-failure-job)", "Cron");
      expectNoteContaining("recorded reason `consecutive-failures` after 10", "Cron");
      expectNoteContaining("openclaw automations enable run-failure-job", "Cron");
      expectNoteContaining("Schedule error job (schedule-error-job)", "Cron");
      expectNoteContaining("recorded reason `schedule-errors` after 3", "Cron");
      expectNoteContaining("openclaw automations enable schedule-error-job", "Cron");
      expectNoNoteContaining("disabled-one-shot", "Cron");
    });
  });

  it("repairs legacy cron store fields and migrates notify fallback to webhook delivery", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const cfg = createCronConfig(storePath);

    await maybeRepairLegacyCronStore({
      cfg,
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.jobId).toBeUndefined();
    expect(job.id).toBe("legacy-job");
    expect(job.notify).toBeUndefined();
    const schedule = requireRecord(job.schedule, "cron schedule");
    expect(schedule.kind).toBe("cron");
    expect(schedule.expr).toBe("0 7 * * *");
    expect(schedule.tz).toBe("UTC");
    const delivery = requireRecord(job.delivery, "cron delivery");
    expect(delivery.mode).toBe("webhook");
    expect(delivery.to).toBe("https://example.invalid/cron-finished");
    const payload = requireRecord(job.payload, "cron payload");
    expect(payload.kind).toBe("systemEvent");
    expect(payload.text).toBe("Morning brief");

    expectNoteContaining("Legacy cron job storage detected", "Cron");
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("repairs legacy top-level array cron stores instead of treating them as empty (#60799)", async () => {
    const storePath = await makeTempStorePath();
    await writeLegacyCronArrayStore(storePath, [createLegacyCronJob()]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.jobId).toBeUndefined();
    expect(job.id).toBe("legacy-job");
    expect(job.notify).toBeUndefined();
    expectNoteContaining("Legacy cron job storage detected", "Cron");
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("archives legacy cron stores when an older migrated archive already exists", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);
    await fs.writeFile(`${storePath}.migrated`, "old archive", "utf-8");

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(`${storePath}.migrated`, "utf-8")).resolves.toBe("old archive");
    await expect(fs.stat(`${storePath}.migrated.2`)).resolves.toBeTruthy();
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("falls back to copy+unlink when renaming the legacy cron store fails with EXDEV", async () => {
    const storePath = await makeTempStorePath();
    const archivePath = `${storePath}.migrated`;
    const sourceMtime = new Date("2026-01-02T03:04:05.000Z");
    await writeCronStore(storePath, [createLegacyCronJob()]);
    await fs.chmod(storePath, 0o640);
    await fs.utimes(storePath, sourceMtime, sourceMtime);

    const renameSpy = mockExdevRename(storePath);
    const realOpen = fs.open.bind(fs);
    let archiveFileSynced = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === archivePath && args[1] === "r+") {
        const realSync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          archiveFileSynced = true;
          await realSync();
        });
      }
      return handle;
    });

    await withRestoredMocks([openSpy, renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      expect(renameSpy).toHaveBeenCalled();
      expect(archiveFileSynced).toBe(true);
      await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(archivePath, "utf-8")).resolves.toContain("legacy-job");
      const archiveStat = await fs.stat(archivePath);
      if (process.platform !== "win32") {
        expect(archiveStat.mode & 0o777).toBe(0o640);
      }
      expect(archiveStat.mtimeMs).toBe(sourceMtime.getTime());
      expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
      expectNoNoteContaining("could not archive the legacy cron file", "Doctor warnings");
    });

    // A second doctor pass must not re-detect (and re-warn about) the archived store.
    noteMock.mockClear();
    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });
    expectNoNoteContaining("Legacy cron job storage detected", "Cron");
  });

  it("refuses a migration plan when the legacy source changes during confirmation", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);
    const changedJob = createLegacyCronJob({ jobId: "changed-job", name: "Changed job" });
    const prompter = {
      confirm: vi.fn(async () => {
        await writeCronStore(storePath, [changedJob]);
        return true;
      }),
    };

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter,
    });

    expect(await readPersistedJobs(storePath)).toHaveLength(0);
    await expect(fs.readFile(storePath, "utf-8")).resolves.toContain("changed-job");
    await expect(fs.stat(`${storePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
    expectNoteContaining("changed while doctor was preparing", "Doctor warnings");
    expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");

    noteMock.mockClear();
    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });
    expect((await readPersistedJobs(storePath)).map((job) => job.id)).toEqual(["changed-job"]);
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("keeps a source that changes during an EXDEV copy and imports it on retry", async () => {
    const storePath = await makeTempStorePath();
    const archivePath = `${storePath}.migrated`;
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const renameSpy = mockExdevRename(storePath);
    const realCopyFile = fs.copyFile.bind(fs);
    const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (src, dest, mode) => {
      await realCopyFile(src, dest, mode);
      if (src === storePath) {
        await writeCronStore(storePath, [
          createLegacyCronJob({ jobId: "late-job", name: "Late job" }),
        ]);
      }
    });

    await withRestoredMocks([copyFileSpy, renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });
    });

    expect((await readPersistedJobs(storePath)).map((job) => job.id)).toEqual(["legacy-job"]);
    await expect(fs.readFile(storePath, "utf-8")).resolves.toContain("late-job");
    await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    expectNoteContaining("changed during archival", "Doctor warnings");

    noteMock.mockClear();
    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });
    expect((await readPersistedJobs(storePath)).map((job) => job.id)).toEqual([
      "legacy-job",
      "late-job",
    ]);
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(archivePath)).resolves.toBeTruthy();
  });

  it("restores an archived state sidecar when the primary archive fails", async () => {
    const storePath = await makeTempStorePath();
    const statePath = storePath.replace(/\.json$/, "-state.json");
    await writeCronStore(storePath, [createLegacyCronJob()]);
    await fs.writeFile(statePath, JSON.stringify({ version: 1, jobs: {} }), "utf-8");

    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (oldPath === storePath) {
        throw createFsError("EIO", "primary archive failed");
      }
      return await realRename(oldPath, newPath);
    });

    await withRestoredMocks([renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });
    });

    await expect(fs.stat(storePath)).resolves.toBeTruthy();
    await expect(fs.stat(statePath)).resolves.toBeTruthy();
    await expect(fs.stat(`${statePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
    expectNoteContaining("EIO", "Doctor warnings");
    expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");

    noteMock.mockClear();
    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${statePath}.migrated`)).resolves.toBeTruthy();
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("restores the primary source when a state sidecar is recreated during archival", async () => {
    const storePath = await makeTempStorePath();
    const statePath = storePath.replace(/\.json$/, "-state.json");
    await writeCronStore(storePath, [createLegacyCronJob()]);
    await fs.writeFile(statePath, JSON.stringify({ version: 1, jobs: {} }), "utf-8");

    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (oldPath === storePath) {
        await fs.writeFile(
          statePath,
          JSON.stringify({ version: 1, jobs: { "legacy-job": { state: { lastRunAtMs: 2 } } } }),
          "utf-8",
        );
      }
      return await realRename(oldPath, newPath);
    });

    await withRestoredMocks([renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });
    });

    await expect(fs.stat(storePath)).resolves.toBeTruthy();
    await expect(fs.readFile(statePath, "utf-8")).resolves.toContain("lastRunAtMs");
    await expect(fs.stat(`${statePath}.migrated`)).resolves.toBeTruthy();
    expectNoteContaining("state appeared after", "Doctor warnings");
    expectNoteContaining("archive rollback failed", "Doctor warnings");
    expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("reports a late state access failure without rejecting doctor", async () => {
    const storePath = await makeTempStorePath();
    const statePath = storePath.replace(/\.json$/, "-state.json");
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const realAccess = fs.access.bind(fs);
    let stateAccesses = 0;
    const accessSpy = vi.spyOn(fs, "access").mockImplementation(async (...args) => {
      if (args[0] === statePath && ++stateAccesses === 2) {
        throw createFsError("EIO", "state access failed");
      }
      return await realAccess(...args);
    });

    await withRestoredMocks([accessSpy], async () => {
      await expect(
        maybeRepairLegacyCronStore({
          cfg: createCronConfig(storePath),
          options: {},
          prompter: makePrompter(true),
        }),
      ).resolves.toBeUndefined();
    });

    await expect(fs.stat(storePath)).resolves.toBeTruthy();
    expectNoteContaining("state access failed", "Doctor warnings");
    expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("removes a partial copy and warns honestly when archiving fails", async () => {
    const storePath = await makeTempStorePath();
    const archivePath = `${storePath}.migrated`;
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const renameSpy = mockExdevRename(storePath);
    const realCopyFile = fs.copyFile;
    const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (src, dest, mode) => {
      if (src === storePath) {
        await fs.writeFile(dest, "partial", "utf-8");
        throw createFsError("ENOSPC", "no space left, copyfile");
      }
      return realCopyFile(src, dest, mode);
    });

    await withRestoredMocks([copyFileSpy, renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      // Both rename and the copy+unlink fallback failed, so the legacy file must remain
      // and doctor must surface a warning instead of claiming a finished migration.
      await expect(fs.stat(storePath)).resolves.toBeTruthy();
      await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      expectNoteContaining("could not archive the legacy cron file", "Doctor warnings");
      expectNoteContaining("ENOSPC", "Doctor warnings");
      expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
    });
  });

  it("accepts a failed copy that already removed its destination", async () => {
    const storePath = await makeTempStorePath();
    const archivePath = `${storePath}.migrated`;
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const renameSpy = mockExdevRename(storePath);
    const realCopyFile = fs.copyFile.bind(fs);
    const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (src, dest) => {
      if (src === storePath) {
        await fs.unlink(dest);
        throw createFsError("EIO", "copyfile failed after destination cleanup");
      }
      return await realCopyFile(src, dest);
    });

    await withRestoredMocks([copyFileSpy, renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      await expect(fs.stat(storePath)).resolves.toBeTruthy();
      await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      expectNoteContaining("EIO", "Doctor warnings");
      expectNoNoteContaining("partial archive remains", "Doctor warnings");
      expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
    });
  });

  it("reports a source stat failure without aborting doctor", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const renameSpy = mockExdevRename(storePath);
    const realStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      if (args[0] === storePath) {
        throw createFsError("EIO", "stat failed");
      }
      return await realStat(...args);
    });

    await withRestoredMocks([statSpy, renameSpy], async () => {
      await expect(
        maybeRepairLegacyCronStore({
          cfg: createCronConfig(storePath),
          options: {},
          prompter: makePrompter(true),
        }),
      ).resolves.toBeUndefined();
      expectNoteContaining("EIO", "Doctor warnings");
      expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
    });
    await expect(fs.stat(storePath)).resolves.toBeTruthy();
  });

  it("reports an archive access failure instead of treating the source as missing", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const realAccess = fs.access.bind(fs);
    let sourceAccesses = 0;
    const accessSpy = vi.spyOn(fs, "access").mockImplementation(async (...args) => {
      if (args[0] === storePath && ++sourceAccesses === 2) {
        throw createFsError("EIO", "access failed");
      }
      return await realAccess(...args);
    });

    await withRestoredMocks([accessSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });
      expectNoteContaining("EIO", "Doctor warnings");
      expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
    });
    await expect(fs.stat(storePath)).resolves.toBeTruthy();
  });

  it("keeps the source and removes the partial archive when durability sync fails", async () => {
    const storePath = await makeTempStorePath();
    const archivePath = `${storePath}.migrated`;
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const renameSpy = mockExdevRename(storePath);
    const realOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === archivePath && args[1] === "r+") {
        vi.spyOn(handle, "sync").mockRejectedValueOnce(createFsError("EIO", "fsync failed"));
      }
      return handle;
    });

    await withRestoredMocks([openSpy, renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      await expect(fs.stat(storePath)).resolves.toBeTruthy();
      await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      expectNoteContaining("EIO", "Doctor warnings");
      expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
    });
  });

  it("keeps the source when syncing the archive directory fails", async () => {
    const storePath = await makeTempStorePath();
    const archivePath = `${storePath}.migrated`;
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const renameSpy = mockExdevRename(storePath);
    const realOpen = fs.open.bind(fs);
    let injectedFailure = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const flags = args[1];
      const opensDirectory =
        flags === "r" ||
        (typeof flags === "number" && (flags & fsSync.constants.O_DIRECTORY) !== 0);
      if (args[0] === path.dirname(storePath) && opensDirectory && !injectedFailure) {
        injectedFailure = true;
        vi.spyOn(handle, "sync").mockRejectedValueOnce(
          createFsError("EIO", "directory fsync failed"),
        );
      }
      return handle;
    });

    await withRestoredMocks([openSpy, renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      await expect(fs.stat(storePath)).resolves.toBeTruthy();
      await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      expectNoteContaining("EIO", "Doctor warnings");
      expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
    });
  });

  it.each([
    { label: "string id", jobId: "legacy-job", expectedId: "legacy-job", jobCount: 1 },
    { label: "numeric id", jobId: 7, expectedId: "7", jobCount: 1 },
    { label: "duplicate missing ids", jobId: undefined, expectedId: undefined, jobCount: 2 },
  ])(
    "rolls back a $label archive and retries without duplicates",
    async ({ jobId, expectedId, jobCount }) => {
      const storePath = await makeTempStorePath();
      const archivePath = `${storePath}.migrated`;
      await writeCronStore(
        storePath,
        Array.from({ length: jobCount }, () => createLegacyCronJob({ id: undefined, jobId })),
      );

      const renameSpy = mockExdevRename(storePath);
      const realUnlink = fs.unlink.bind(fs);
      const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
        if (target === storePath) {
          throw createFsError("EBUSY", "resource busy, unlink");
        }
        return await realUnlink(target);
      });

      await withRestoredMocks([unlinkSpy, renameSpy], async () => {
        await maybeRepairLegacyCronStore({
          cfg: createCronConfig(storePath),
          options: {},
          prompter: makePrompter(true),
        });

        await expect(fs.stat(storePath)).resolves.toBeTruthy();
        await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
        expectNoteContaining("EBUSY", "Doctor warnings");
        expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
      });

      const firstJobs = await readPersistedJobs(storePath);
      expect(firstJobs).toHaveLength(jobCount);
      if (expectedId) {
        expect(firstJobs[0]?.id).toBe(expectedId);
      } else {
        const ids = firstJobs.map((job) => job.id);
        expect(ids).toHaveLength(new Set(ids).size);
        for (const id of ids) {
          expect(id).toMatch(/^cron-migrated-\d+-[a-f0-9]{64}$/);
        }
      }

      noteMock.mockClear();
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });

      await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(archivePath)).resolves.toBeTruthy();
      await expect(fs.stat(`${archivePath}.2`)).rejects.toMatchObject({ code: "ENOENT" });
      const secondJobs = await readPersistedJobs(storePath);
      expect(secondJobs).toHaveLength(jobCount);
      expect(secondJobs.map((job) => job.id)).toEqual(firstJobs.map((job) => job.id));
      expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
    },
  );

  it("does not resurrect a migrated job removed before an archive retry", async () => {
    const storePath = await makeTempStorePath();
    const archivePath = `${storePath}.migrated`;
    await writeCronStore(storePath, [createLegacyCronJob({ id: undefined, jobId: undefined })]);

    const renameSpy = mockExdevRename(storePath);
    const realUnlink = fs.unlink.bind(fs);
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
      if (target === storePath) {
        throw createFsError("EBUSY", "resource busy, unlink");
      }
      return await realUnlink(target);
    });

    await withRestoredMocks([unlinkSpy, renameSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });
      expectNoteContaining("EBUSY", "Doctor warnings");
    });
    expect(await readPersistedJobs(storePath)).toHaveLength(1);

    // Simulate runtime-owned one-shot deletion after SQLite import but before cleanup retry.
    await writeCurrentCronStore(storePath, []);
    noteMock.mockClear();
    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    expect(await readPersistedJobs(storePath)).toHaveLength(0);
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(archivePath)).resolves.toBeTruthy();
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("imports legacy-only jobs when SQLite already has cron rows", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [
      createCurrentCronJob({
        id: "legacy-job",
        name: "SQLite wins",
      }),
    ]);
    await writeCronStore(storePath, [
      createLegacyCronJob({
        name: "Stale duplicate",
      }),
      createLegacyCronJob({
        jobId: "legacy-only",
        name: "Legacy only",
      }),
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    expect(jobs.map((job) => job.id)).toEqual(["legacy-job", "legacy-only"]);
    expect(requirePersistedJob(jobs, 0).name).toBe("SQLite wins");
    expect(requirePersistedJob(jobs, 1).name).toBe("Legacy only");
    expectNoteContaining("1 legacy JSON cron job will be imported into SQLite", "Cron");
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("migrates legacy run logs even when the legacy job store was already archived", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [createCurrentCronJob()]);
    const runLogPath = path.join(path.dirname(storePath), "runs", "sqlite-job.jsonl");
    await fs.mkdir(path.dirname(runLogPath), { recursive: true });
    await fs.writeFile(
      runLogPath,
      `${JSON.stringify({
        ts: Date.parse("2026-02-04T00:00:00.000Z"),
        jobId: "sqlite-job",
        action: "finished",
        status: "ok",
        summary: "done",
      })}\n`,
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const entries = readCronTaskRunHistoryPage({
      storeKey: cronStoreKey(storePath),
      jobId: "sqlite-job",
    }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.jobId).toBe("sqlite-job");
    expect(entries[0]?.summary).toBe("done");
    await expect(fs.stat(runLogPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${runLogPath}.migrated`)).resolves.toBeTruthy();
    expectNoteContaining("legacy JSON cron run logs will be imported into SQLite", "Cron");
    expectNoteContaining("Cron run logs migrated to SQLite", "Doctor changes");
  });

  it("does not report store normalization when run-log migration fails", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [createCurrentCronJob()]);
    const runLogPath = path.join(path.dirname(storePath), "runs", "sqlite-job.jsonl");
    await fs.mkdir(path.dirname(runLogPath), { recursive: true });
    await fs.writeFile(runLogPath, "{}\n", "utf-8");

    const realReadFileSync = fsSync.readFileSync.bind(fsSync);
    const readSpy = vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, options) => {
      if (filePath === runLogPath) {
        throw createFsError("EIO", "run-log read failed");
      }
      return realReadFileSync(filePath as never, options as never) as never;
    });

    await withRestoredMocks([readSpy], async () => {
      await maybeRepairLegacyCronStore({
        cfg: createCronConfig(storePath),
        options: {},
        prompter: makePrompter(true),
      });
    });

    await expect(fs.stat(runLogPath)).resolves.toBeTruthy();
    expectNoteContaining("run-log read failed", "Doctor warnings");
    expectNoNoteContaining("Cron store normalized", "Doctor changes");
    expectNoNoteContaining("Cron run logs migrated", "Doctor changes");
  });

  it("does not claim legacy store detected when only non-legacy issues exist (#92683)", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [
      createCurrentCronJob({
        id: "notify-job",
        name: "Notify job",
        notify: true,
      }),
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    expectNoNoteContaining("Legacy cron job storage detected", "Cron");
    expectNoteContaining("Cron store issues detected", "Cron");
    expectNoteContaining("1 job still uses legacy", "Cron");
    expectNoNoteContaining("jobs.json", "Cron");
  });

  it("advises on isolated shell-prompt jobs without a non-actionable --fix repair note (#94655)", async () => {
    const storePath = await makeTempStorePath();
    const shellPromptJobs: Array<Record<string, unknown>> = [
      createCurrentCronJob({
        id: "shell-prompt-job-1",
        name: "Shell prompt job 1",
        schedule: { kind: "cron", expr: "*/30 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message:
            "Run python3 scripts/check_mail.py and send a compact summary if anything changed.",
          toolsAllow: ["*"],
        },
        delivery: { mode: "announce" },
      }),
      createCurrentCronJob({
        id: "shell-prompt-job-2",
        name: "Shell prompt job 2",
        schedule: { kind: "cron", expr: "15 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: "Run node scripts/check_mail.js and summarize any new messages.",
          toolsAllow: ["bash"],
        },
        delivery: { mode: "announce" },
      }),
      createCurrentCronJob({
        id: "shell-prompt-job-3",
        name: "Shell prompt job 3",
        schedule: { kind: "cron", expr: "45 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: "Execute ./scripts/check_mail.sh and report changed mailbox counts.",
          toolsAllow: ["process"],
        },
        delivery: { mode: "announce" },
      }),
    ];
    const shellPromptJob = requirePersistedJob(shellPromptJobs, 0);
    await writeCurrentCronStore(storePath, shellPromptJobs);

    const prompter = makePrompter(true);
    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter,
    });

    // The advisory is informational only: doctor --fix cannot rewrite a working
    // isolated agentTurn job, so the misleading repair note must stay absent.
    expectNoNoteContaining("Cron store issues detected", "Cron");
    expectNoteContaining(
      "3 isolated automations drive shell/process tools from the agent prompt and keep running as-is: `Shell prompt job 1`, `Shell prompt job 2`, `Shell prompt job 3`.",
      "Cron",
    );
    expectNoteContaining("informational only", "Cron");
    expectNoteContaining("Shell prompt job 1", "Cron");
    expectNoteContaining("Shell prompt job 2", "Cron");
    expectNoteContaining("Shell prompt job 3", "Cron");
    expectNoNoteContaining("openclaw doctor --fix", "Cron");
    expectNoNoteContaining("jobs.json", "Cron");
    expect(prompter.confirm).not.toHaveBeenCalled();

    // No churn: the advisory does not rewrite the still-working jobs.
    const persistedJobs = await readPersistedJobs(storePath);
    expect(persistedJobs).toEqual(shellPromptJobs);
    const job = requirePersistedJob(persistedJobs, 0);
    expect(job).toEqual(shellPromptJob);
    const reloaded = await loadCronJobsStoreWithConfigJobs(storePath);
    expect(reloaded.configJobIndexes).toEqual([0, 1, 2]);
    expect(reloaded.invalidConfigRows).toEqual([]);
    const configJob = requirePersistedJob(reloaded.configJobs, 0);
    expect(configJob).toEqual(
      Object.fromEntries(Object.entries(shellPromptJob).filter(([key]) => key !== "updatedAtMs")),
    );
    expect(reloaded.configJobRuntimeEntries[0]).toEqual({
      updatedAtMs: shellPromptJob.updatedAtMs,
      state: {},
      scheduleIdentity: JSON.stringify({
        version: 2,
        enabled: shellPromptJob.enabled,
        schedule: shellPromptJob.schedule,
        hasTrigger: false,
      }),
    });
    const payload = requireRecord(job.payload, "cron payload");
    expect(payload.kind).toBe("agentTurn");
    expect(payload.message).toContain("python3 scripts/check_mail.py");
  });

  it("keeps restricted command prompts actionable without a --fix repair note", async () => {
    const storePath = await makeTempStorePath();
    const commandPromptJob = createCurrentCronJob({
      id: "restricted-command-prompt",
      name: "Restricted command prompt",
      schedule: { kind: "cron", expr: "*/30 * * * *", tz: "UTC" },
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: [
          "Command to run:",
          "- command: python3 scripts/check_mail.py",
          "- workdir: /home/openclaw/.razor/clawd",
        ].join("\n"),
        toolsAllow: ["read", "message"],
      },
      delivery: { mode: "announce" },
    });
    await writeCurrentCronStore(storePath, [commandPromptJob]);

    const prompter = makePrompter(true);
    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter,
    });

    expectNoNoteContaining("Cron store issues detected", "Cron");
    expectNoteContaining(
      "1 isolated automation describes a shell command in the agent prompt but lacks shell/process tool access: `Restricted command prompt`.",
      "Cron",
    );
    expectNoteContaining("not the supported shell-tool prompt shape", "Cron");
    expectNoteContaining("Recreate it as a command automation", "Cron");
    expectNoNoteContaining("informational only", "Cron");
    expectNoNoteContaining("keep running as-is", "Cron");
    expectNoNoteContaining("openclaw doctor --fix", "Cron");
    expect(prompter.confirm).not.toHaveBeenCalled();

    const job = requirePersistedJob(await readPersistedJobs(storePath), 0);
    const payload = requireRecord(job.payload, "cron payload");
    expect(payload.kind).toBe("agentTurn");
    expect(payload.message).toContain("python3 scripts/check_mail.py");
    expect(payload.toolsAllow).toEqual(["read", "message"]);
  });

  it("repairs malformed persisted cron ids before list rendering sees them", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      createLegacyCronJob({
        id: 42,
        jobId: undefined,
        notify: false,
      }),
      createLegacyCronJob({
        id: undefined,
        jobId: undefined,
        name: "Missing id",
        notify: false,
      }),
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const firstJob = requirePersistedJob(jobs, 0);
    const secondJob = requirePersistedJob(jobs, 1);
    expect(firstJob.id).toBe("42");
    expect(typeof secondJob.id).toBe("string");
    expect(String(secondJob.id)).toMatch(/^cron-/);
    expectNoteContaining("stores `id` as a non-string value", "Cron");
    expectNoteContaining("missing a canonical string `id`", "Cron");
  });

  it("migrates notify fallback alongside announce delivery without replacing it", async () => {
    const storePath = await makeTempStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "notify-and-announce",
              name: "Notify and announce",
              notify: true,
              createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
              updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "Status" },
              delivery: { to: "telegram:123" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: { nonInteractive: true },
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.notify).toBeUndefined();
    const delivery = requireRecord(job.delivery, "cron delivery");
    expect(delivery.mode).toBe("announce");
    expect(delivery.channel).toBeUndefined();
    expect(delivery.to).toBe("telegram:123");
    expect(delivery.completionDestination).toEqual({
      mode: "webhook",
      to: "https://example.invalid/cron-finished",
    });
    expectNoNoteContaining(
      "uses legacy notify fallback alongside delivery mode",
      "Doctor warnings",
    );
  });

  it("does not auto-repair in non-interactive mode without explicit repair approval", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const prompter = makePrompter(false);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: { nonInteractive: true },
      prompter,
    });

    expect(await readPersistedJobs(storePath)).toEqual([]);
    const legacy = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    const job = requirePersistedJob(legacy.jobs, 0);
    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "Repair legacy cron jobs now?",
      initialValue: true,
    });
    expect(job.jobId).toBe("legacy-job");
    expect(job.id).toBeUndefined();
    expect(job.notify).toBe(true);
    expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("migrates notify fallback none delivery jobs to cron.webhook", async () => {
    const storePath = await makeTempStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "notify-none",
              name: "Notify none",
              notify: true,
              createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
              updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
              schedule: { kind: "every", everyMs: 60_000 },
              payload: {
                kind: "systemEvent",
                text: "Status",
              },
              delivery: { mode: "none", to: "123456789" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.notify).toBeUndefined();
    const delivery = requireRecord(job.delivery, "cron delivery");
    expect(delivery.mode).toBe("webhook");
    expect(delivery.to).toBe("https://example.invalid/cron-finished");
  });

  it("migrates invalid legacy notify webhook delivery jobs to cron.webhook", async () => {
    const storePath = await makeTempStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "notify-invalid-webhook",
              name: "Notify invalid webhook",
              notify: true,
              createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
              updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
              schedule: { kind: "every", everyMs: 60_000 },
              payload: {
                kind: "systemEvent",
                text: "Status",
              },
              delivery: { mode: "webhook", to: "ftp://example.invalid/cron" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.notify).toBeUndefined();
    const delivery = requireRecord(job.delivery, "cron delivery");
    expect(delivery.mode).toBe("webhook");
    expect(delivery.to).toBe("https://example.invalid/cron-finished");
  });

  it("warns when cron.webhook is invalid for a legacy notify fallback", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      createLegacyCronJob({
        id: "notify-invalid-config",
        jobId: undefined,
        delivery: undefined,
      }),
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath, "ftp://example.invalid/cron-finished"),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.notify).toBeUndefined();
    expect(job.delivery).toBeUndefined();
    const reloaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const persisted = reloaded.configJobs as unknown as Array<Record<string, unknown>>;
    expect(persisted[0]?.notify).toBe(true);
    expectNoteContaining(
      "cron.webhook is not a valid HTTP(S) URL so doctor cannot migrate it automatically",
      "Doctor warnings",
    );
  });

  it("does not migrate legacy notify fallback from a credential-bearing webhook URL", async () => {
    const storePath = await makeTempStorePath();
    const credentialUrl = new URL("https://example.invalid/cron-finished?token=placeholder");
    credentialUrl.username = "user";
    credentialUrl.password = "password";
    await writeCronStore(storePath, [
      createLegacyCronJob({
        id: "notify-credential-config",
        jobId: undefined,
        delivery: undefined,
      }),
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath, credentialUrl.href),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.notify).toBeUndefined();
    expect(job.delivery).toBeUndefined();
    const reloaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const persisted = reloaded.configJobs as unknown as Array<Record<string, unknown>>;
    expect(persisted[0]?.notify).toBe(true);
    expectNoteContaining(
      "cron.webhook is not a valid HTTP(S) URL so doctor cannot migrate it automatically",
      "Doctor warnings",
    );
    expect(JSON.stringify(noteMock.mock.calls)).not.toContain(credentialUrl.href);
  });

  it("removes inert legacy notify:true for delivery.mode none when cron.webhook is unset and stops looping (#44460)", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      createCurrentCronJob({
        id: "notify-none-unset",
        name: "Notify none unset",
        notify: true,
        delivery: { mode: "none" },
      }),
    ]);

    const cfg = { cron: { store: storePath } } as unknown as OpenClawConfig;
    await maybeRepairLegacyCronStore({
      cfg,
      options: {},
      prompter: makePrompter(true),
    });

    const reloaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const persisted = reloaded.configJobs as unknown as Array<Record<string, unknown>>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.notify).toBeUndefined();
    expect(requireRecord(persisted[0]?.delivery, "cron delivery").mode).toBe("none");
    expectNoNoteContaining(
      "cron.webhook is unset so doctor cannot migrate it automatically",
      "Doctor warnings",
    );

    noteMock.mockClear();
    await maybeRepairLegacyCronStore({
      cfg,
      options: {},
      prompter: makePrompter(true),
    });
    expectNoNoteContaining("still uses legacy `notify: true`", "Cron");
  });

  it("drops inert legacy notify alongside existing announce delivery without changing it when cron.webhook is unset (#44460)", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      createCurrentCronJob({
        id: "notify-announce-unset",
        name: "Notify announce unset",
        notify: true,
        payload: { kind: "agentTurn", message: "Status" },
        delivery: { mode: "announce", to: "telegram:123" },
      }),
    ]);

    const cfg = { cron: { store: storePath } } as unknown as OpenClawConfig;
    await maybeRepairLegacyCronStore({
      cfg,
      options: {},
      prompter: makePrompter(true),
    });

    const reloaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const persisted = reloaded.configJobs as unknown as Array<Record<string, unknown>>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.notify).toBeUndefined();
    const delivery = requireRecord(persisted[0]?.delivery, "cron delivery");
    expect(delivery.mode).toBe("announce");
    expect(delivery.to).toBe("telegram:123");
  });

  it("quarantines invalid legacy rows before saving the repaired store", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      createLegacyCronJob({
        id: "invalid-legacy-cron",
        jobId: undefined,
        schedule: { kind: "cron" },
      }),
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    expect(await readPersistedJobs(storePath)).toEqual([]);
    const quarantine = loadCronQuarantinedJobs(storePath);
    expect(quarantine[0]?.reason).toBe("invalid-schedule");
    expect(quarantine[0]?.job?.id).toBe("invalid-legacy-cron");
  });

  it("repairs legacy root delivery threadId hints into delivery", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      {
        id: "legacy-thread-hint",
        name: "Legacy thread hint",
        enabled: true,
        createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
        schedule: { kind: "cron", cron: "0 7 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
        },
        channel: " telegram ",
        to: "-1001234567890",
        threadId: " 99 ",
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.channel).toBeUndefined();
    expect(job.to).toBeUndefined();
    expect(job.threadId).toBeUndefined();
    const delivery = requireRecord(job.delivery, "cron delivery");
    expect(delivery.mode).toBe("announce");
    expect(delivery.channel).toBe("telegram");
    expect(delivery.to).toBe("-1001234567890");
    expect(delivery.threadId).toBe("99");
  });

  it("rewrites stale managed dreaming jobs to the isolated agentTurn shape", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      {
        id: "memory-dreaming",
        name: "Memory Dreaming Promotion",
        description:
          "[managed-by=memory-core.short-term-promotion] Promote weighted short-term recalls.",
        enabled: true,
        createdAtMs: Date.parse("2026-04-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-04-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: {
          kind: "systemEvent",
          text: "__openclaw_memory_core_short_term_promotion_dream__",
        },
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.sessionTarget).toBe("isolated");
    const payload = requireRecord(job.payload, "cron payload");
    expect(payload.kind).toBe("agentTurn");
    expect(payload.message).toBe("__openclaw_memory_core_short_term_promotion_dream__");
    expect(payload.lightContext).toBe(true);
    const delivery = requireRecord(job.delivery, "cron delivery");
    expect(delivery.mode).toBe("none");
    expectNoteContaining("managed dreaming job", "Cron");
    expectNoteContaining("Rewrote 1 managed dreaming job", "Doctor changes");
  });

  it("warns and continues when the cron job store cannot be read", async () => {
    const storePath = await makeTempStorePath();
    // Force loadCronStore to throw a non-ENOENT read error by placing a
    // directory where the cron job store file would be. This mirrors the
    // Docker-on-root permission failure reported in #86102 without depending
    // on the test runner's effective uid (root bypasses chmod gates).
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.mkdir(storePath);
    const prompter = makePrompter(true);

    await expect(
      maybeRepairLegacyCronStore({
        cfg: { cron: { store: storePath } } as unknown as OpenClawConfig,
        options: {},
        prompter,
      }),
    ).resolves.toBeUndefined();

    expect(prompter.confirm).not.toHaveBeenCalled();
    expectNoteContaining("Unable to read cron job store at", "Cron");
    expectNoteContaining("later health checks will continue", "Cron");
  });
});

describe("legacy WhatsApp crontab health check", () => {
  it("collects a warning about legacy ensure-whatsapp crontab entries on Linux", async () => {
    const warning = await collectLegacyWhatsAppCrontabHealthWarning({
      platform: "linux",
      readCrontab: async () => ({
        stdout: [
          "# keep comments ignored",
          "*/5 * * * * ~/.openclaw/bin/ensure-whatsapp.sh >> ~/.openclaw/logs/whatsapp-health.log 2>&1",
          "0 9 * * * /usr/bin/true",
          "",
        ].join("\n"),
      }),
    });

    expect(warning).toContain("Legacy WhatsApp crontab health check detected");
    expect(warning).toContain("systemd user bus environment is missing");
    expect(warning).toContain("Matched 1 entry");
  });

  it("warns about legacy ensure-whatsapp crontab entries on Linux", async () => {
    await noteLegacyWhatsAppCrontabHealthCheck({
      platform: "linux",
      readCrontab: async () => ({
        stdout: [
          "# keep comments ignored",
          "*/5 * * * * ~/.openclaw/bin/ensure-whatsapp.sh >> ~/.openclaw/logs/whatsapp-health.log 2>&1",
          "0 9 * * * /usr/bin/true",
          "",
        ].join("\n"),
      }),
    });

    expectNoteContaining("Legacy WhatsApp crontab health check detected", "Cron");
    expectNoteContaining("systemd user bus environment is missing", "Cron");
    expectNoteContaining("Matched 1 entry", "Cron");
  });

  it("ignores missing crontab support and non-Linux hosts", async () => {
    await noteLegacyWhatsAppCrontabHealthCheck({
      platform: "darwin",
      readCrontab: async () => {
        throw new Error("should not read crontab on non-Linux");
      },
    });
    await noteLegacyWhatsAppCrontabHealthCheck({
      platform: "linux",
      readCrontab: async () => {
        throw Object.assign(new Error("crontab missing"), { code: "ENOENT" });
      },
    });

    expect(noteMock).not.toHaveBeenCalled();
  });

  it("ignores malformed crontab output instead of crashing", async () => {
    await expect(
      noteLegacyWhatsAppCrontabHealthCheck({
        platform: "linux",
        readCrontab: async () => ({
          stdout: undefined,
        }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      noteLegacyWhatsAppCrontabHealthCheck({
        platform: "linux",
        readCrontab: async () => ({
          stdout: 12345,
        }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      noteLegacyWhatsAppCrontabHealthCheck({
        platform: "linux",
        readCrontab: async () => ({
          stdout: { lines: ["*/5 * * * * ~/.openclaw/bin/ensure-whatsapp.sh"] },
        }),
      }),
    ).resolves.toBeUndefined();

    expect(noteMock).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
