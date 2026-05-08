import fs from "node:fs/promises";
import path from "node:path";
import {
  generateExperimentalCodexAppServerProtocolSource,
  selectedCodexAppServerJsonSchemas,
} from "./lib/codex-app-server-protocol-source.js";

const generatedRoot = path.resolve(
  process.cwd(),
  "extensions/codex/src/app-server/protocol-generated",
);

const checks: Array<{ file: string; snippets: string[] }> = [
  {
    file: "ServerRequest.ts",
    snippets: [
      '"item/commandExecution/requestApproval"',
      '"item/fileChange/requestApproval"',
      '"item/permissions/requestApproval"',
      '"item/tool/call"',
    ],
  },
  {
    file: "v2/ThreadItem.ts",
    snippets: [
      'type: "contextCompaction"',
      'type: "dynamicToolCall"',
      'type: "commandExecution"',
      'type: "mcpToolCall"',
    ],
  },
  {
    file: "v2/DynamicToolSpec.ts",
    snippets: ["name: string", "description: string", "inputSchema: JsonValue"],
  },
  {
    file: "v2/CommandExecutionApprovalDecision.ts",
    snippets: ['"accept"', '"acceptForSession"', '"decline"', '"cancel"'],
  },
  {
    file: "v2/Account.ts",
    snippets: ['type: "apiKey"', 'type: "chatgpt"', 'type: "amazonBedrock"'],
  },
  {
    file: "v2/ThreadStartParams.ts",
    snippets: [
      "permissions?: PermissionProfileSelectionParams | null",
      "dynamicTools?: Array<DynamicToolSpec> | null",
      "experimentalRawEvents: boolean",
      "persistExtendedHistory: boolean",
    ],
  },
  {
    file: "v2/TurnStartParams.ts",
    snippets: [
      "permissions?: PermissionProfileSelectionParams | null",
      "serviceTier?: string | null",
    ],
  },
  {
    file: "ReviewDecision.ts",
    snippets: ['"approved"', '"approved_for_session"', '"denied"', '"abort"'],
  },
  {
    file: "v2/PlanDeltaNotification.ts",
    snippets: ["itemId: string", "delta: string"],
  },
  {
    file: "v2/TurnPlanUpdatedNotification.ts",
    snippets: ["explanation: string | null", "plan: Array<TurnPlanStep>"],
  },
];

const failures: string[] = [];
const source = await generateExperimentalCodexAppServerProtocolSource();

try {
  await compareGeneratedProtocolMirror(source.jsonRoot);

  for (const check of checks) {
    const filePath = path.join(source.typescriptRoot, check.file);
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch (error) {
      failures.push(`${check.file}: missing (${String(error)})`);
      continue;
    }
    for (const snippet of check.snippets) {
      if (!text.includes(snippet)) {
        failures.push(`${check.file}: missing ${snippet}`);
      }
    }
  }
} finally {
  await source.cleanup();
}

if (failures.length > 0) {
  console.error("Codex app-server generated protocol drift:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error(
    `Run \`pnpm codex-app-server:protocol:sync\` after refreshing the Codex checkout at ${source.codexRepo}.`,
  );
  process.exit(1);
}

console.log(
  `Codex app-server generated protocol matches OpenClaw bridge assumptions: ${source.codexRepo}`,
);

async function compareGeneratedProtocolMirror(sourceJsonRoot: string): Promise<void> {
  for (const schema of selectedCodexAppServerJsonSchemas) {
    const sourcePath = path.join(sourceJsonRoot, schema);
    const targetPath = path.join(generatedRoot, "json", schema);
    let source: string;
    let target: string;
    try {
      source = await fs.readFile(sourcePath, "utf8");
    } catch (error) {
      failures.push(
        `protocol-generated/json/${schema}: missing upstream schema (${String(error)})`,
      );
      continue;
    }
    try {
      target = await fs.readFile(targetPath, "utf8");
    } catch (error) {
      failures.push(`protocol-generated/json/${schema}: missing local schema (${String(error)})`);
      continue;
    }
    if (normalizeJsonSchema(source) !== normalizeJsonSchema(target)) {
      failures.push(`protocol-generated/json/${schema}: differs from source schema`);
    }
  }
}

function normalizeJsonSchema(source: string): string {
  return JSON.stringify(JSON.parse(source));
}
