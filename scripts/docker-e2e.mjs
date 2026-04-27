// Docker E2E CI helper.
// Converts scheduler JSON into GitHub Actions outputs and compact markdown
// summaries so the workflow does not duplicate Docker E2E planning logic.
import fs from "node:fs";

function usage() {
  return [
    "Usage:",
    "  node scripts/docker-e2e.mjs github-outputs <plan.json>",
    "  node scripts/docker-e2e.mjs summary <summary.json> <title>",
    "  node scripts/docker-e2e.mjs failed-reruns <summary.json>",
  ].join("\n");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function boolOutput(value) {
  return value ? "1" : "0";
}

function githubOutputs(plan) {
  const needs = plan.needs ?? {};
  return [
    `credentials=${(plan.credentials ?? []).join(",")}`,
    `needs_bare_image=${boolOutput(needs.bareImage)}`,
    `needs_e2e_image=${boolOutput(needs.e2eImage)}`,
    `needs_functional_image=${boolOutput(needs.functionalImage)}`,
    `needs_live_image=${boolOutput(needs.liveImage)}`,
    `needs_package=${boolOutput(needs.package)}`,
  ];
}

function markdownCell(value) {
  return String(value ?? "").replaceAll("|", "\\|");
}

function inlineCode(value) {
  return `\`${String(value ?? "").replaceAll("`", "\\`")}\``;
}

function formatSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "";
  }
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function summaryMarkdown(summary, title) {
  const lanes = Array.isArray(summary.lanes) ? summary.lanes : [];
  const slowest = lanes
    .filter((lane) => Number.isFinite(Number(lane.elapsedSeconds)))
    .toSorted((a, b) => Number(b.elapsedSeconds) - Number(a.elapsedSeconds))
    .slice(0, 8);
  const lines = [
    `### ${title}`,
    "",
    `Status: ${inlineCode(summary.status)}`,
    "",
    "| Lane | Status | Seconds | Timed out | Rerun |",
    "| --- | ---: | ---: | --- | --- |",
  ];
  for (const lane of lanes) {
    const status = lane.status === 0 ? "pass" : `fail ${lane.status}`;
    lines.push(
      `| ${inlineCode(lane.name)} | ${markdownCell(status)} | ${markdownCell(lane.elapsedSeconds)} | ${lane.timedOut ? "yes" : "no"} | ${inlineCode(lane.rerunCommand)} |`,
    );
  }

  if (slowest.length > 0) {
    lines.push("", "| Slowest lane | Duration | Status |", "| --- | ---: | --- |");
    for (const lane of slowest) {
      const status = lane.status === 0 ? "pass" : `fail ${lane.status}`;
      lines.push(
        `| ${inlineCode(lane.name)} | ${markdownCell(formatSeconds(lane.elapsedSeconds))} | ${markdownCell(status)} |`,
      );
    }
  }

  const phases = Array.isArray(summary.phases) ? summary.phases : [];
  if (phases.length > 0) {
    lines.push("", "| Phase | Duration | Status | Image kind |", "| --- | ---: | --- | --- |");
    for (const phase of phases) {
      lines.push(
        `| ${inlineCode(phase.name)} | ${markdownCell(formatSeconds(phase.elapsedSeconds))} | ${markdownCell(phase.status)} | ${markdownCell(phase.imageKind)} |`,
      );
    }
  }
  const failedReruns = failedRerunCommands(summary);
  if (failedReruns.length > 0) {
    lines.push("", "Failed lane reruns:", "");
    for (const command of failedReruns) {
      lines.push(`- ${inlineCode(command)}`);
    }
  }
  return lines.join("\n");
}

function failedRerunCommands(summary) {
  const lanes = Array.isArray(summary.lanes) ? summary.lanes : [];
  return lanes
    .filter((lane) => lane.status !== 0 && lane.rerunCommand)
    .map((lane) => lane.rerunCommand);
}

const [command, file, ...args] = process.argv.slice(2);
if (!command || !file) {
  throw new Error(usage());
}

if (command === "github-outputs") {
  process.stdout.write(`${githubOutputs(readJson(file)).join("\n")}\n`);
} else if (command === "summary") {
  const title = args.join(" ").trim();
  if (!title) {
    throw new Error(usage());
  }
  process.stdout.write(`${summaryMarkdown(readJson(file), title)}\n`);
} else if (command === "failed-reruns") {
  process.stdout.write(`${failedRerunCommands(readJson(file)).join("\n")}\n`);
} else {
  throw new Error(`unknown command: ${command}\n${usage()}`);
}
