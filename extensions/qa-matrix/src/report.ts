export type QaReportCheck = {
  name: string;
  status: "pass" | "fail" | "skip";
  details?: string;
};

type QaReportScenario = {
  name: string;
  status: "pass" | "fail" | "skip";
  details?: string;
  steps?: QaReportCheck[];
};

function pushDetailsBlock(lines: string[], label: string, details: string, indent = "") {
  if (!details.includes("\n")) {
    lines.push(`${indent}- ${label}: ${details}`);
    return;
  }
  lines.push(`${indent}- ${label}:`);
  lines.push("", "```text", details, "```");
}

export function renderQaMarkdownReport(params: {
  title: string;
  startedAt: Date;
  finishedAt: Date;
  checks?: QaReportCheck[];
  scenarios?: QaReportScenario[];
  timeline?: string[];
  notes?: string[];
}) {
  const checks = params.checks ?? [];
  const scenarios = params.scenarios ?? [];
  const passCount =
    checks.filter((check) => check.status === "pass").length +
    scenarios.filter((scenario) => scenario.status === "pass").length;
  const failCount =
    checks.filter((check) => check.status === "fail").length +
    scenarios.filter((scenario) => scenario.status === "fail").length;

  const lines = [
    `# ${params.title}`,
    "",
    `- Started: ${params.startedAt.toISOString()}`,
    `- Finished: ${params.finishedAt.toISOString()}`,
    `- Duration ms: ${params.finishedAt.getTime() - params.startedAt.getTime()}`,
    `- Passed: ${passCount}`,
    `- Failed: ${failCount}`,
    "",
  ];

  if (checks.length > 0) {
    lines.push("## Checks", "");
    for (const check of checks) {
      lines.push(`- [${check.status === "pass" ? "x" : " "}] ${check.name}`);
      if (check.details) {
        pushDetailsBlock(lines, "Details", check.details, "  ");
      }
    }
  }

  if (scenarios.length > 0) {
    lines.push("", "## Scenarios", "");
    for (const scenario of scenarios) {
      lines.push(`### ${scenario.name}`);
      lines.push("");
      lines.push(`- Status: ${scenario.status}`);
      if (scenario.details) {
        pushDetailsBlock(lines, "Details", scenario.details);
      }
      if (scenario.steps?.length) {
        lines.push("- Steps:");
        for (const step of scenario.steps) {
          lines.push(`  - [${step.status === "pass" ? "x" : " "}] ${step.name}`);
          if (step.details) {
            pushDetailsBlock(lines, "Details", step.details, "    ");
          }
        }
      }
      lines.push("");
    }
  }

  if (params.timeline && params.timeline.length > 0) {
    lines.push("## Timeline", "");
    for (const item of params.timeline) {
      lines.push(`- ${item}`);
    }
  }

  if (params.notes && params.notes.length > 0) {
    lines.push("", "## Notes", "");
    for (const note of params.notes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
