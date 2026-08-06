import { scanSkillContent, scanSource } from "../security/scanner.js";
import type { PreparedSkillProposalSupportFile } from "./store.js";
import type { SkillProposalScan } from "./types.js";

export function scanProposalBundle(
  content: string,
  supportFiles: readonly PreparedSkillProposalSupportFile[] = [],
  metadata: readonly { file: string; content: string | undefined }[] = [],
): SkillProposalScan {
  const scannedAt = new Date().toISOString();
  const findings = [
    ...scanSkillContent(content, "PROPOSAL.md"),
    ...scanSource(content, "PROPOSAL.md"),
    ...supportFiles.flatMap((file) => [
      ...scanSkillContent(file.path, "support-file-path").filter(
        (finding) => finding.ruleId === "literal-secret",
      ),
      ...scanSkillContent(file.content, file.path),
      ...scanSource(file.content, file.path),
    ]),
    ...metadata.flatMap((entry) =>
      entry.content
        ? scanSkillContent(entry.content, entry.file).filter(
            (finding) => finding.ruleId === "literal-secret",
          )
        : [],
    ),
  ];
  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const warn = findings.filter((finding) => finding.severity === "warn").length;
  const info = findings.filter((finding) => finding.severity === "info").length;
  return {
    state: critical > 0 ? "failed" : "clean",
    scannedAt,
    critical,
    warn,
    info,
    findings,
  };
}

export function assertProposalContainsNoLiteralSecrets(scan: SkillProposalScan): void {
  const finding = scan.findings.find((entry) => entry.ruleId === "literal-secret");
  if (!finding) {
    return;
  }
  throw new Error(
    `Skill proposal contains a recognized literal credential in ${finding.file}; replace it with a SecretRef or placeholder.`,
  );
}
