import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CandidateBuild, LaneState, ParsedArgs, SummaryPayload } from "./config.ts";
import { trimForSummary } from "./shared.ts";

export function writeSummary(baseDir: string, summaryPayload: SummaryPayload) {
  const summaryJsonPath = join(baseDir, "summary.json");
  const summaryMarkdownPath = join(baseDir, "summary.md");
  writeFileSync(summaryJsonPath, `${JSON.stringify(summaryPayload, null, 2)}\n`, "utf8");
  const result = summaryPayload.result ?? {};

  const lines = [
    `## ${platformLabel()}`,
    "",
    `- Provider: \`${summaryPayload.provider}\``,
    `- Suite: \`${summaryPayload.suite}\``,
    `- Mode: \`${summaryPayload.mode}\``,
    `- Source SHA: \`${summaryPayload.sourceSha || "unknown"}\``,
    `- Candidate version: \`${summaryPayload.candidateVersion || "unknown"}\``,
    `- Baseline spec: \`${summaryPayload.baselineSpec}\``,
    result.status ? `- Result: \`${result.status}\`` : "",
    result.installTarget ? `- Install target: \`${result.installTarget}\`` : "",
    result.installVersion ? `- Install version: \`${result.installVersion}\`` : "",
    result.baselineVersion ? `- Baseline version: \`${result.baselineVersion}\`` : "",
    result.installedVersion ? `- Installed version: \`${result.installedVersion}\`` : "",
    result.installedCommit ? `- Installed commit: \`${result.installedCommit}\`` : "",
    result.cliPath ? `- CLI path: \`${result.cliPath}\`` : "",
    result.gatewayPort ? `- Gateway port: \`${result.gatewayPort}\`` : "",
    result.dashboardStatus ? `- Dashboard: \`${result.dashboardStatus}\`` : "",
    result.discordStatus ? `- Discord: \`${result.discordStatus}\`` : "",
    result.agentOutput ? `- Agent output: \`${trimForSummary(result.agentOutput)}\`` : "",
    result.error ? `- Error: \`${trimForSummary(result.error)}\`` : "",
  ].filter(Boolean);
  if (Array.isArray(result.phaseTimings) && result.phaseTimings.length > 0) {
    lines.push("", "### Phase timings");
    for (const phase of result.phaseTimings) {
      const suffix = phase.status === "pass" ? "" : ` (${phase.status})`;
      lines.push(`- \`${phase.name}\`: ${Math.round(phase.durationMs / 1000)}s${suffix}`);
    }
  }
  writeFileSync(summaryMarkdownPath, `${lines.join("\n")}\n`, "utf8");
}

export function writeCandidateManifest(baseDir: string, build: CandidateBuild) {
  const manifestPath = join(baseDir, "candidate.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        sourceSha: build.sourceSha,
        candidateVersion: build.candidateVersion,
        candidateFileName: build.candidateFileName,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function platformLabel() {
  if (process.platform === "darwin") {
    return "macOS Release Checks";
  }
  if (process.platform === "win32") {
    return "Windows Release Checks";
  }
  return "Linux Release Checks";
}

export function requireArg(argsMap: ParsedArgs, key: string) {
  const value = argsMap[key]?.trim();
  if (!value) {
    throw new Error(`Missing required --${key} argument.`);
  }
  return value;
}

export function logPhase(scope: string, phase: string) {
  process.stdout.write(`[release-checks] ${scope}: ${phase}\n`);
}

export function logLanePhase(lane: LaneState, phase: string) {
  logPhase(`lane.${lane.name}`, phase);
}

export async function runTimedLanePhase<T>(
  lane: LaneState,
  phase: string,
  callback: () => Promise<T>,
) {
  const startedAt = Date.now();
  logLanePhase(lane, phase);
  try {
    const result = await callback();
    const durationMs = Date.now() - startedAt;
    lane.phaseTimings.push({ name: phase, status: "pass", durationMs });
    logPhase(`lane.${lane.name}`, `${phase}: done in ${Math.round(durationMs / 1000)}s`);
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    lane.phaseTimings.push({ name: phase, status: "fail", durationMs });
    logPhase(`lane.${lane.name}`, `${phase}: failed in ${Math.round(durationMs / 1000)}s`);
    throw error;
  }
}
