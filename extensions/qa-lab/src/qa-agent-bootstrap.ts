import {
  DEFAULT_QA_AGENT_IDENTITY_MARKDOWN,
  readQaBootstrapScenarioCatalog,
} from "./scenario-catalog.js";

export function readQaAgentIdentityMarkdown(): string {
  return (
    readQaBootstrapScenarioCatalog().agentIdentityMarkdown || DEFAULT_QA_AGENT_IDENTITY_MARKDOWN
  );
}

export function buildQaScenarioPlanMarkdown(): string {
  const catalog = readQaBootstrapScenarioCatalog();
  const lines = ["# QA Scenario Plan", ""];
  for (const scenario of catalog.scenarios) {
    lines.push(`## ${scenario.title}`);
    lines.push("");
    lines.push(`- id: ${scenario.id}`);
    lines.push(`- surface: ${scenario.surface}`);
    lines.push(`- objective: ${scenario.objective}`);
    if (scenario.execution?.summary) {
      lines.push(`- execution: ${scenario.execution.summary}`);
    }
    lines.push("- success criteria:");
    for (const criterion of scenario.successCriteria) {
      lines.push(`  - ${criterion}`);
    }
    if (scenario.docsRefs?.length) {
      lines.push("- docs:");
      for (const ref of scenario.docsRefs) {
        lines.push(`  - ${ref}`);
      }
    }
    if (scenario.codeRefs?.length) {
      lines.push("- code:");
      for (const ref of scenario.codeRefs) {
        lines.push(`  - ${ref}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
