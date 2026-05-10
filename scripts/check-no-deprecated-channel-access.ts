import fs from "node:fs";
import path from "node:path";
import { collectFilesSync, isCodeFile, relativeToCwd } from "./check-file-utils.js";
import { classifyBundledExtensionSourcePath } from "./lib/extension-source-classifier.mjs";

type Rule = {
  label: string;
  pattern: RegExp;
};

const RULES: Rule[] = [
  {
    label: "deprecated channel ingress resolver aliases",
    pattern:
      /\b(?:resolved|result|directResolved|groupResolved)\.(?:legacyAccess|senderReasonCode|commandAuthorized|shouldBlockControlCommand)\b/u,
  },
  {
    label: "inline deprecated channel ingress legacyAccess projection",
    pattern: /\)\.legacyAccess\b/u,
  },
  {
    label: "low-level compatibility ingress resolver",
    pattern: /\bresolveChannelIngressAccess\b/u,
  },
  {
    label: "deprecated channel ingress compatibility projection",
    pattern:
      /\b(?:findChannelIngressSenderReasonCode|formatChannelIngressPolicyReason|mapChannelIngressReasonCodeToDmGroupAccessReason|projectChannelIngressDmGroupAccess|projectChannelIngressSenderGroupAccess)\b/u,
  },
  {
    label: "deprecated pairing-store access helper",
    pattern: /\breadStoreAllowFromForDmPolicy\b/u,
  },
  {
    label: "deprecated DM/group access helper",
    pattern: /\bresolveDmGroupAccessWith(?:Lists|CommandGate)\b/u,
  },
  {
    label: "deprecated DM/group access reason constants",
    pattern: /\bDM_GROUP_ACCESS_REASON\b/u,
  },
  {
    label: "deprecated group policy access helper",
    pattern:
      /\b(?:resolveSenderScopedGroupPolicy|evaluateSenderGroupAccess(?:ForPolicy)?|evaluateGroupRouteAccessForPolicy|evaluateMatchedGroupAccessForPolicy)\b/u,
  },
  {
    label: "deprecated group access compatibility module",
    pattern: /from\s+["']openclaw\/plugin-sdk\/group-access["']/u,
  },
  {
    label: "deprecated command authorization helper",
    pattern: /\bresolveSenderCommandAuthorization(?:WithRuntime)?\b/u,
  },
  {
    label: "deprecated command auth SDK facade",
    pattern: /from\s+["']openclaw\/plugin-sdk\/command-auth["']/u,
  },
  {
    label: "deprecated AccessFacts command authorizers",
    pattern: /\bcommands\.authorizers\b/u,
  },
];

function collectBundledPluginProductionFiles(): string[] {
  const extensionsDir = path.join(process.cwd(), "extensions");
  return collectFilesSync(extensionsDir, {
    includeFile(filePath) {
      if (!isCodeFile(filePath)) {
        return false;
      }
      const repoPath = relativeToCwd(filePath);
      const classified = classifyBundledExtensionSourcePath(repoPath);
      return classified.isProductionSource;
    },
  }).toSorted((left, right) => relativeToCwd(left).localeCompare(relativeToCwd(right)));
}

function main() {
  const offenders: Array<{ file: string; line: number; label: string; text: string }> = [];
  for (const file of collectBundledPluginProductionFiles()) {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      for (const rule of RULES) {
        if (rule.pattern.test(line)) {
          offenders.push({
            file: relativeToCwd(file),
            line: index + 1,
            label: rule.label,
            text: line.trim(),
          });
        }
      }
    }
  }

  if (offenders.length > 0) {
    console.error(
      "Bundled plugin production code must use modern channel access results, not deprecated compatibility seams.",
    );
    for (const offender of offenders) {
      console.error(`- ${offender.file}:${offender.line}: ${offender.label}: ${offender.text}`);
    }
    process.exit(1);
  }

  console.log("OK: bundled plugin production code avoids deprecated channel access seams.");
}

main();
