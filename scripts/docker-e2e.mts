// Docker E2E CI helper.
// Converts scheduler JSON into GitHub Actions outputs and compact markdown
// summaries so the workflow does not duplicate Docker E2E planning logic.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readDockerE2eJsonArtifact } from "./lib/docker-e2e-json-artifacts.mts";

function recordOrEmpty(value: unknown) {
  return asOptionalRecord(value) ?? {};
}

function recordArray(value: unknown) {
  return Array.isArray(value) ? value.map(recordOrEmpty) : [];
}

function usage() {
  return [
    "Usage:",
    "  node scripts/docker-e2e.mjs github-outputs <plan.json>",
    "  node scripts/docker-e2e.mjs summary <summary.json> <title>",
    "  node scripts/docker-e2e.mjs failed-reruns <summary.json>",
  ].join("\n");
}

function boolOutput(value: unknown) {
  return value ? "1" : "0";
}

function githubOutputs(value: unknown) {
  const plan = recordOrEmpty(value);
  const needs = recordOrEmpty(plan.needs);
  const credentials = Array.isArray(plan.credentials)
    ? plan.credentials.filter(
        (credential: unknown): credential is string => typeof credential === "string",
      )
    : [];
  const requiredPackages: unknown[] = Array.isArray(plan.requiredPrepublishPluginPackages)
    ? plan.requiredPrepublishPluginPackages
    : [];
  return [
    `credentials=${credentials.join(",")}`,
    `needs_bare_image=${boolOutput(needs.bareImage)}`,
    `needs_e2e_image=${boolOutput(needs.e2eImage)}`,
    `needs_functional_image=${boolOutput(needs.functionalImage)}`,
    `needs_live_image=${boolOutput(needs.liveImage)}`,
    `needs_package=${boolOutput(needs.package)}`,
    `needs_prepublish_plugin_registry=${boolOutput(needs.prepublishPluginRegistry)}`,
    `required_prepublish_plugin_packages=${JSON.stringify(requiredPackages)}`,
  ];
}

function markdownCell(value: unknown) {
  const text =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";
  return text.replaceAll("|", "\\|");
}

function inlineCode(value: unknown) {
  const text =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";
  return `\`${text.replaceAll("`", "\\`")}\``;
}

function formatSeconds(value: unknown) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "";
  }
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function summaryMarkdown(value: unknown, title: string) {
  const summary = recordOrEmpty(value);
  const lanes = recordArray(summary.lanes);
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
    const status = lane.status === 0 ? "pass" : `fail ${markdownCell(lane.status)}`;
    lines.push(
      `| ${inlineCode(lane.name)} | ${status} | ${markdownCell(lane.elapsedSeconds)} | ${lane.timedOut ? "yes" : "no"} | ${inlineCode(lane.rerunCommand)} |`,
    );
  }

  if (slowest.length > 0) {
    lines.push("", "| Slowest lane | Duration | Status |", "| --- | ---: | --- |");
    for (const lane of slowest) {
      const status = lane.status === 0 ? "pass" : `fail ${markdownCell(lane.status)}`;
      lines.push(
        `| ${inlineCode(lane.name)} | ${markdownCell(formatSeconds(lane.elapsedSeconds))} | ${status} |`,
      );
    }
  }

  const phases = recordArray(summary.phases);
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

function failedRerunCommands(value: unknown) {
  const summary = recordOrEmpty(value);
  const lanes = recordArray(summary.lanes);
  return lanes.flatMap((lane) =>
    lane.status !== 0 && typeof lane.rerunCommand === "string" && lane.rerunCommand
      ? [lane.rerunCommand]
      : [],
  );
}

function main(argv: string[] = process.argv.slice(2)) {
  const [command, file, ...args] = argv;
  if (command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!command || !file) {
    throw new Error(usage());
  }

  if (command === "github-outputs") {
    process.stdout.write(`${githubOutputs(readDockerE2eJsonArtifact(file)).join("\n")}\n`);
  } else if (command === "summary") {
    const title = args.join(" ").trim();
    if (!title) {
      throw new Error(usage());
    }
    process.stdout.write(`${summaryMarkdown(readDockerE2eJsonArtifact(file), title)}\n`);
  } else if (command === "failed-reruns") {
    process.stdout.write(`${failedRerunCommands(readDockerE2eJsonArtifact(file)).join("\n")}\n`);
  } else {
    throw new Error(`unknown command: ${command}\n${usage()}`);
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
