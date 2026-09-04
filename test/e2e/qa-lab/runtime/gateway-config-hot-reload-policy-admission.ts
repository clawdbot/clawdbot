// Config admission coverage with bounded public consumer checks where no external service is needed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { waitForHotReloadFact } from "./gateway-config-hot-reload-fixtures.js";

type Snapshot = { hash: string; config: OpenClawConfig };
type AdmissionCase = {
  family: string;
  change: OpenClawConfig;
  restore: unknown;
  replacePaths: string[];
  readConsumer?: () => Promise<unknown>;
  probe?: () => Promise<void>;
  expectedConsumer?: unknown;
  consumerObservation?: string;
};

export async function proveHotReloadPolicyAdmission({
  gateway,
  temporaryRoot,
  outputDir,
  turn,
  rpc,
  patch,
  proveGroup,
  verifyContinuity,
}: {
  gateway: QaGatewayChild;
  temporaryRoot: string;
  outputDir: string;
  turn: (message: string, sessionKey?: string) => Promise<string>;
  rpc: <T>(method: string, params?: unknown) => Promise<T>;
  patch: (change: unknown, replacePaths?: string[]) => Promise<unknown>;
  proveGroup: (prefix: string, run: () => Promise<void>) => Promise<void>;
  verifyContinuity: (prefix: string, observation: string) => Promise<void>;
}) {
  const initial = (await rpc<Snapshot>("config.get")).config;
  const root = await fs.mkdtemp(path.join(temporaryRoot, "policy-consumers-"));
  const observations: Array<Record<string, unknown>> = [];
  const readAudit = async () => {
    const report = JSON.parse(await gateway.runCli(["security", "audit", "--json"])) as {
      findings: Array<{ checkId: string }>;
      suppressedFindings?: Array<{ checkId: string; suppression: { reason?: string } }>;
    };
    const checkId = "summary.attack_surface";
    return {
      active: report.findings.some((finding) => finding.checkId === checkId),
      suppressed: (report.suppressedFindings ?? [])
        .filter((finding) => finding.checkId === checkId)
        .map((finding) => finding.suppression.reason),
    };
  };
  const probeProjectMapping = async () => {
    const repository = path.join(root, "repository");
    await fs.mkdir(repository);
    const git = (args: string[]) => promisify(execFile)("git", args, { cwd: repository });
    await git(["init", "--initial-branch=main"]);
    await fs.writeFile(path.join(repository, "proof.txt"), "Synthetic project mapping\n");
    await git(["add", "proof.txt"]);
    await git([
      "-c",
      "user.name=QA",
      "-c",
      "user.email=qa@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Synthetic fixture",
    ]);
    await git(["remote", "add", "origin", "https://example.invalid/qa/project.git"]);
    const session = await rpc<{ key: string; worktree?: { id: string; path: string } }>(
      "sessions.create",
      {
        agentId: "qa",
        cwd: repository,
        worktree: true,
        worktreeBaseRef: "main",
        worktreeName: `policy-${randomUUID()}`,
        label: "Synthetic project mapping",
      },
    );
    assert(session.worktree, "Project mapping probe requires a session-owned managed worktree");
    try {
      for (const profileId of ["qa-absent-a", "qa-absent-b", null]) {
        assert(!profileId || !initial.cloudWorkers?.profiles?.[profileId]);
        await patch(
          {
            cloudWorkers: {
              projectProfiles: profileId ? { "example.invalid/qa/project": profileId } : null,
            },
          },
          ["cloudWorkers.projectProfiles"],
        );
        const expected = profileId
          ? `cloudWorkers.projectProfiles mapping example.invalid/qa/project references unconfigured profile ${profileId}`
          : "worker dispatch target is missing";
        await assert.rejects(rpc("sessions.dispatch", { key: session.key }), (error: unknown) => {
          assert(
            String(error).includes(expected),
            `Unexpected project mapping failure: ${String(error)}`,
          );
          observations.push({ family: "cloudWorkers.projectProfiles", rejected: expected });
          return true;
        });
      }
    } finally {
      const deleted = await rpc<{ deleted: boolean; worktreePreserved?: unknown }>(
        "sessions.delete",
        {
          key: session.key,
          deleteTranscript: true,
        },
      );
      assert.equal(deleted.deleted, true);
      assert.equal(deleted.worktreePreserved, undefined, "Synthetic worktree cleanup failed");
    }
  };
  const probeInstallPolicy = async () => {
    const source = path.join(root, "skill");
    const script = path.join(root, "policy.mjs");
    const policyLog = path.join(root, "install-policy.log");
    const command = await fs.realpath(process.execPath);
    const skillText =
      "---\nname: synthetic-install-policy\ndescription: Synthetic local install proof\n---\nReply with a brief greeting.\n";
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "SKILL.md"), skillText);
    await fs.writeFile(policyLog, "");
    await fs.writeFile(
      script,
      `import { appendFileSync } from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.protocolVersion !== 1 || request.targetType !== 'skill' || request.source.network !== false) throw new Error('Unexpected synthetic install request');
const decision = process.argv[2];
appendFileSync(${JSON.stringify(policyLog)}, JSON.stringify({ targetName: request.targetName, decision }) + '\\n');
process.stdout.write(JSON.stringify({ protocolVersion: 1, decision, reason: 'Synthetic policy block' }));
`,
      { mode: 0o600 },
    );
    const targets: string[] = [];
    try {
      const phases = [
        { enabled: true, target: "skill", decision: "block" },
        { enabled: true, target: "skill", decision: "allow" },
        { enabled: true, target: "skill", decision: "block" },
        { enabled: false, target: "skill", decision: "block" },
        { enabled: true, target: "plugin", decision: "block" },
      ] as const;
      for (const [index, phase] of phases.entries()) {
        const slug = `policy-${index}-${randomUUID()}`;
        const target = path.join(gateway.workspaceDir, "skills", slug);
        targets.push(target);
        await patch(
          {
            security: {
              installPolicy: {
                enabled: phase.enabled,
                targets: [phase.target],
                exec: {
                  source: "exec",
                  command,
                  args: [script, phase.decision],
                  trustedDirs: [root, path.dirname(command)],
                },
              },
            },
          } satisfies OpenClawConfig,
          [
            "security.installPolicy.targets",
            "security.installPolicy.exec.args",
            "security.installPolicy.exec.trustedDirs",
          ],
        );
        const invoke = () =>
          gateway.runCli(["skills", "install", source, "--agent", "qa", "--as", slug]);
        const invoked = phase.enabled && phase.target === "skill";
        const blocked = invoked && phase.decision === "block";
        if (blocked) {
          await assert.rejects(
            invoke(),
            /Install blocked by policy[\s\S]*Reason: Synthetic policy block/,
          );
          await assert.rejects(fs.stat(target), { code: "ENOENT" });
        } else {
          assert((await invoke()).includes(`Installed ${slug} from path ->`));
          assert.equal(await fs.readFile(path.join(target, "SKILL.md"), "utf8"), skillText);
        }
        const records = (await fs.readFile(policyLog, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { targetName: string; decision: string })
          .filter((entry) => entry.targetName === slug);
        assert.deepEqual(records, invoked ? [{ targetName: slug, decision: phase.decision }] : []);
        observations.push({
          family: "security.installPolicy",
          phase: index,
          ...phase,
          invoked,
          blocked,
        });
      }
    } finally {
      for (const target of targets) {
        await fs.rm(target, { recursive: true, force: true });
      }
    }
  };
  const probeDiagnostics = async () => {
    for (const key of [
      "OPENCLAW_DIAGNOSTICS",
      "OPENCLAW_CACHE_TRACE",
      "OPENCLAW_CACHE_TRACE_FILE",
    ]) {
      assert(!gateway.runtimeEnv[key], `${key} would override the config proof`);
    }
    const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
    assert(stateDir);
    const tracePath = path.join(stateDir, "logs", "cache-trace.jsonl");
    const traceRows = async () => {
      let text: string;
      try {
        text = await fs.readFile(tracePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
      // Only complete appended records count; an in-progress final write is not a corrupt trace.
      return text
        .slice(0, text.lastIndexOf("\n") + 1)
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { runId?: string; sessionKey?: string; stage: string });
    };
    const runs: Array<{ runId: string; sessionKey: string; enabled: boolean }> = [];
    for (const [index, enabled] of [false, true, false, true].entries()) {
      await patch(
        { diagnostics: { flags: enabled ? ["ingress.timing"] : [], cacheTrace: { enabled } } },
        ["diagnostics.flags"],
      );
      const sessionKey = `agent:qa:policy-diagnostics-${randomUUID()}`;
      const marker = `POLICY_DIAGNOSTICS_${index}`;
      const runId = await turn(`Reply exactly \`${marker}\``, sessionKey);
      const history = await rpc<{
        messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      }>("chat.history", { sessionKey });
      assert(
        history.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content.some((part) => part.type === "text" && part.text?.includes(marker)),
        ),
        "Diagnostic probe requires actual assistant output",
      );
      runs.push({ runId, sessionKey, enabled });
      if (enabled) {
        await waitForHotReloadFact("cache trace completion", async () =>
          (await traceRows()).some((row) => row.runId === runId && row.stage === "session:after")
            ? true
            : undefined,
        );
        await waitForHotReloadFact("ingress diagnostic log", () =>
          gateway.logs().includes(`[model-selection] session=${sessionKey} stage=`)
            ? true
            : undefined,
        );
      }
    }
    // The final enabled turn witnesses the shared append FIFO after the disabled turn.
    const rows = await traceRows();
    for (const run of runs) {
      assert.equal(
        rows.some((row) => row.runId === run.runId),
        run.enabled,
      );
      assert.equal(
        gateway.logs().includes(`[model-selection] session=${run.sessionKey} stage=`),
        run.enabled,
      );
      observations.push({
        family: "diagnostics.flags/cacheTrace.enabled",
        ...run,
        stages: rows.filter((row) => row.runId === run.runId).map((row) => row.stage),
      });
    }
  };
  const profile = Object.entries(initial.auth?.profiles ?? {})[0];
  assert(profile, "QA Gateway must have its staged model auth profile");
  const [profileId, profileConfig] = profile;
  const readAuthProjection = async () => {
    const status = await rpc<{
      unavailable?: unknown;
      providers: Array<{
        profileOrder?: string[];
        profileOrderStored?: boolean;
        profiles: Array<{ profileId: string; displayName?: string }>;
      }>;
    }>("models.authStatus", { agentId: "qa" });
    assert.equal(status.unavailable, undefined, "Prepared model auth owner is unavailable");
    const provider = status.providers.find((entry) =>
      entry.profiles.some((profileEntry) => profileEntry.profileId === profileId),
    );
    const currentProfile = provider?.profiles.find((entry) => entry.profileId === profileId);
    assert(provider && currentProfile, "Prepared auth status omitted the staged QA profile");
    assert.notEqual(
      provider.profileOrderStored,
      true,
      "A stored auth order would mask config ordering",
    );
    return {
      displayName: currentProfile.displayName ?? null,
      profileOrder: provider.profileOrder ?? null,
    };
  };
  const readAcpInstallReply = async () => {
    const sessionKey = `agent:qa:hot-reload-acp-hint-${randomUUID()}`;
    await rpc("chat.send", {
      sessionKey,
      message: "/acp install",
      deliver: false,
      idempotencyKey: randomUUID(),
    });
    // Command replies are persisted asynchronously; the authored prompt is never evidence.
    return await waitForHotReloadFact("ACP install command reply", async () => {
      const history = await rpc<{
        messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      }>("chat.history", { sessionKey });
      const reply = history.messages.find((message) => message.role === "assistant");
      if (!reply) {
        return undefined;
      }
      const text = reply.content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
      assert(text.startsWith("ACP install:\n"), "Expected an ACP command reply, not model output");
      const hint = text.split("\n").find((line) => line.startsWith("run: "));
      assert(hint, "ACP command omitted its install hint");
      return hint;
    });
  };
  const readUpdateChannel = async () => {
    const status = await rpc<{ effectiveChannel?: string }>("update.status");
    assert(status.effectiveChannel, "Update status omitted the effective channel");
    return status.effectiveChannel;
  };
  const quiet = {
    update: { checkOnStart: false, auto: { enabled: false } },
    telemetry: { enabled: false },
  } as const;
  // Keep these guards in every candidate/restore while testing metadata. No update or ping is requested.
  await patch(quiet);
  const cases: AdmissionCase[] = [
    {
      family: "auth.order/profiles",
      change: {
        auth: {
          order: { ...initial.auth?.order, [profileConfig.provider]: [profileId] },
          profiles: {
            ...initial.auth?.profiles,
            [profileId]: { ...profileConfig, displayName: "Synthetic reload admission" },
          },
        },
      },
      restore: {
        auth: {
          order: {
            [profileConfig.provider]: initial.auth?.order?.[profileConfig.provider] ?? null,
          },
          profiles: { [profileId]: { displayName: profileConfig.displayName ?? null } },
        },
      },
      replacePaths: [`auth.order.${profileConfig.provider}`],
      readConsumer: readAuthProjection,
      expectedConsumer: { displayName: "Synthetic reload admission", profileOrder: [profileId] },
      consumerObservation:
        "Prepared models.authStatus reflected the profile display name and config order, then restored both; credential selection and provider authentication were not exercised",
    },
    {
      family: "broadcast",
      change: { broadcast: { strategy: "sequential", "qa-unused-target": ["qa"] } },
      restore: { broadcast: initial.broadcast ?? null },
      replacePaths: ["broadcast.qa-unused-target"],
    },
    {
      family: "cloudWorkers.projectProfiles",
      probe: probeProjectMapping,
      consumerObservation:
        "Real sessions.dispatch selected mapping A then B and rejected each unconfigured profile; removing the mapping restored the missing-target error, before any worker provisioning",
      change: {
        cloudWorkers: { projectProfiles: { "example.invalid/qa/project": "qa-unused-profile" } },
      },
      restore: { cloudWorkers: { projectProfiles: initial.cloudWorkers?.projectProfiles ?? null } },
      replacePaths: ["cloudWorkers.projectProfiles"],
    },
    {
      family: "security.audit.suppressions",
      readConsumer: readAudit,
      expectedConsumer: { active: false, suppressed: ["Synthetic suppression proof"] },
      consumerObservation:
        "The built security audit CLI moved the real attack-surface finding into suppressedFindings with its reason and restored it; this proves subsequent CLI reads, not a retained audit service",
      change: {
        security: {
          audit: {
            suppressions: [
              {
                checkId: "summary.attack_surface",
                reason: "Synthetic suppression proof",
              },
            ],
          },
        },
      },
      restore: {
        security: { audit: { suppressions: initial.security?.audit?.suppressions ?? null } },
      },
      replacePaths: ["security.audit.suppressions"],
    },
    {
      family: "security.installPolicy",
      probe: probeInstallPolicy,
      consumerObservation:
        "Built skills install invoked the configured local policy and blocked→installed→blocked a synthetic skill; disabling the policy or excluding skills bypassed it and installed successfully",
      change: { security: { installPolicy: { enabled: false, targets: ["skill"] } } },
      restore: { security: { installPolicy: initial.security?.installPolicy ?? null } },
      replacePaths: [
        "security.installPolicy.targets",
        "security.installPolicy.exec.args",
        "security.installPolicy.exec.trustedDirs",
      ],
    },
    {
      family: "diagnostics.flags/cacheTrace.enabled",
      probe: probeDiagnostics,
      consumerObservation:
        "Four real mock-provider turns switched ingress timing logs and cache trace records off→on→off→on; assistant replies and a later trace completion witnessed the disabled phase",
      change: { diagnostics: { flags: ["qa.admission"], cacheTrace: { enabled: false } } },
      restore: {
        diagnostics: {
          flags: initial.diagnostics?.flags ?? null,
          cacheTrace: initial.diagnostics?.cacheTrace ?? null,
        },
      },
      replacePaths: ["diagnostics.flags", "diagnostics.cacheTrace"],
    },
    {
      family: "acp.stream/runtime.installCommand",
      change: {
        acp: {
          stream: {
            deliveryMode: "live",
            repeatSuppression: false,
            tagVisibility: { tool_call: true },
          },
          runtime: { installCommand: "printf 'Synthetic ACP install hint'" },
        },
      },
      restore: {
        acp: {
          stream: initial.acp?.stream ?? null,
          runtime: { installCommand: initial.acp?.runtime?.installCommand ?? null },
        },
      },
      replacePaths: ["acp.stream"],
      readConsumer: readAcpInstallReply,
      expectedConsumer: "run: printf 'Synthetic ACP install hint'",
      consumerObservation:
        "Real /acp install assistant replies changed to the configured hint and back; no command was executed and ACP streaming projection was not exercised",
    },
    {
      family: "update.channel/checkOnStart/auto.enabled",
      readConsumer: readUpdateChannel,
      expectedConsumer: initial.update?.channel === "beta" ? "stable" : "beta",
      consumerObservation:
        "update.status reflected the configured channel and restored it; scheduled checkOnStart/auto.enabled behavior was not exercised",
      change: {
        update: {
          channel: initial.update?.channel === "beta" ? "stable" : "beta",
          checkOnStart: false,
          auto: { enabled: false },
        },
      },
      restore: {
        update: { ...initial.update, ...quiet.update, channel: initial.update?.channel ?? null },
      },
      replacePaths: [],
    },
    {
      family: "telemetry.enabled/consentedAt",
      change: { telemetry: { enabled: false, consentedAt: new Date().toISOString() } },
      restore: {
        telemetry: {
          ...initial.telemetry,
          enabled: false,
          consentedAt: initial.telemetry?.consentedAt ?? null,
        },
      },
      replacePaths: [],
    },
  ];
  try {
    for (const entry of cases) {
      const prefix = `config admission: ${entry.family}`;
      await proveGroup(prefix, async () => {
        const before = await rpc<Snapshot>("config.get");
        const beforeConsumer = await entry.readConsumer?.();
        if (entry.readConsumer) {
          assert.notDeepEqual(
            beforeConsumer,
            entry.expectedConsumer,
            `${entry.family} consumer probe would be a no-op`,
          );
        }
        try {
          await patch(entry.change, entry.replacePaths);
          const after = await rpc<Snapshot>("config.get");
          assert.notEqual(
            after.hash,
            before.hash,
            `${entry.family} candidate did not change config`,
          );
          assert.equal(after.config.update?.checkOnStart, false);
          assert.equal(after.config.update?.auto?.enabled, false);
          assert.equal(after.config.telemetry?.enabled, false);
          if (entry.readConsumer) {
            const consumer = await entry.readConsumer();
            assert.deepEqual(consumer, entry.expectedConsumer);
            observations.push({ family: entry.family, consumer });
          }
          await entry.probe?.();
        } finally {
          await patch(entry.restore, entry.replacePaths);
          if (entry.readConsumer) {
            assert.deepEqual(
              await entry.readConsumer(),
              beforeConsumer,
              `${entry.family} consumer did not restore`,
            );
          }
        }
        await verifyContinuity(
          prefix,
          entry.consumerObservation
            ? `Config admission and public consumer: ${entry.consumerObservation}; same Gateway boot/socket`
            : "Config admission only: real schema, runtime preparation, publication, and same Gateway boot/socket; downstream behavior was not exercised",
        );
      });
    }
  } finally {
    await patch({ update: initial.update ?? null, telemetry: initial.telemetry ?? null }, [
      "update",
      "telemetry",
    ]);
    await fs.writeFile(
      path.join(outputDir, "gateway-config-hot-reload-policy-admission.json"),
      `${JSON.stringify(observations, null, 2)}\n`,
    );
  }
}
