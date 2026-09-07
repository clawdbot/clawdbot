import path from "node:path";

type MantisReportLine = string | undefined;

export type MantisCrabboxReportSummary = {
  artifacts: {
    reportPath: string;
    screenshotPath?: string;
    summaryPath: string;
    videoPath?: string;
  };
  crabbox: {
    bin: string;
    createdLease: boolean;
    id: string;
    provider: string;
    slug?: string;
    state?: string;
    vncCommand: string;
  };
  error?: string;
  finishedAt: string;
  outputDir: string;
  startedAt: string;
  status: "pass" | "fail";
};

export function renderMantisCrabboxReport(params: {
  afterArtifacts?: MantisReportLine[];
  artifactRows: MantisReportLine[];
  beforeArtifacts?: MantisReportLine[];
  crabboxRows?: MantisReportLine[];
  headerRows: MantisReportLine[];
  summary: MantisCrabboxReportSummary;
  title: string;
}) {
  const { summary } = params;
  const { crabbox } = summary;
  const lines = [
    `# ${params.title}`,
    "",
    `Status: ${summary.status}`,
    ...params.headerRows,
    `Output: ${summary.outputDir}`,
    `Started: ${summary.startedAt}`,
    `Finished: ${summary.finishedAt}`,
    "",
    "## Crabbox",
    "",
    `- Provider: ${crabbox.provider}`,
    `- Lease: ${crabbox.id}${crabbox.slug ? ` (${crabbox.slug})` : ""}`,
    `- Created by run: ${crabbox.createdLease}`,
    `- State: ${crabbox.state ?? "unknown"}`,
    `- VNC: \`${crabbox.vncCommand}\``,
    ...(params.crabboxRows ?? []),
    "",
    ...(params.beforeArtifacts ?? []),
    "## Artifacts",
    "",
    summary.artifacts.screenshotPath
      ? `- Screenshot: \`${path.basename(summary.artifacts.screenshotPath)}\``
      : "- Screenshot: missing",
    summary.artifacts.videoPath
      ? `- Video: \`${path.basename(summary.artifacts.videoPath)}\``
      : "- Video: missing",
    ...params.artifactRows,
    "",
    ...(params.afterArtifacts ?? []),
  ].filter((line) => line !== undefined);
  return `${lines.join("\n")}\n`;
}
