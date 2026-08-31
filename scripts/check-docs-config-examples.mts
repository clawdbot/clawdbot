#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditDocsConfigExamples } from "../src/config/docs-config-examples.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = auditDocsConfigExamples({ repoRoot });

console.log(`docs_config_files_scanned=${result.stats.filesScanned}`);
console.log(`docs_config_fences_seen=${result.stats.fencesSeen}`);
console.log(`docs_config_fences_validated=${result.stats.candidatesValidated}`);
console.log(`docs_config_fences_skipped=${result.stats.fencesSkipped}`);
console.log(`docs_config_skipped_unsupported_language=${result.stats.skippedUnsupportedLanguage}`);
console.log(`docs_config_skipped_opt_out=${result.stats.skippedOptOut}`);
console.log(`docs_config_skipped_parse_failure=${result.stats.skippedParseFailure}`);
console.log(`docs_config_skipped_non_object=${result.stats.skippedNonObject}`);
console.log(`docs_config_skipped_fragment=${result.stats.skippedFragment}`);

for (const finding of result.findings) {
  console.log(
    `${finding.filePath}:${finding.fenceStartLine} :: ${finding.issuePath} :: ${finding.message}`,
  );
}

if (result.findings.length > 0) {
  console.log(
    "Update each example to the current schema, or annotate a deliberately partial or illustrative fence with validate=false.",
  );
  process.exit(1);
}
