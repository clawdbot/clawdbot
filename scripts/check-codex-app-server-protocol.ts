import { spawnSync } from "node:child_process";
// Check Codex App Server Protocol script supports OpenClaw repository automation.
import fs from "node:fs/promises";
import path from "node:path";
import {
  codexAppServerSharedDefinitionsSchema,
  compactCodexAppServerProtocolJsonSchemas,
  expandCodexAppServerProtocolJsonSchema,
  generateExperimentalCodexAppServerProtocolSource,
  normalizeCodexAppServerProtocolJsonText,
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
      "delivery: AgentMessageDelivery | null",
      'type: "contextCompaction"',
      'type: "dynamicToolCall"',
      'type: "commandExecution"',
      'type: "mcpToolCall"',
    ],
  },
  {
    file: "v2/DynamicToolSpec.ts",
    snippets: [
      '"function"',
      "& DynamicToolFunctionSpec",
      '"namespace"',
      "& DynamicToolNamespaceSpec",
    ],
  },
  {
    file: "v2/DynamicToolFunctionSpec.ts",
    snippets: ["name: string", "description: string", "inputSchema: JsonValue"],
  },
  {
    file: "v2/DynamicToolNamespaceSpec.ts",
    snippets: ["name: string", "description: string", "tools: Array<DynamicToolNamespaceTool>"],
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
    file: "v2/AppSummary.ts",
    snippets: [
      "description: string | null",
      "installUrl: string | null",
      "category: string | null",
    ],
  },
  {
    file: "v2/AppsInstalledParams.ts",
    snippets: ["threadId?: string | null", "forceRefresh?: boolean"],
  },
  {
    file: "v2/AppsInstalledResponse.ts",
    snippets: ["apps: Array<InstalledApp>"],
  },
  {
    file: "v2/AppsReadParams.ts",
    snippets: ["appIds: Array<string>", "threadId?: string | null", "includeTools?: boolean"],
  },
  {
    file: "v2/AppsReadResponse.ts",
    snippets: ["apps: Array<ConnectorMetadata>", "missingAppIds: Array<string>"],
  },
  {
    file: "v2/CommandExecParams.ts",
    snippets: [
      "command: Array<string>",
      "outputBytesCap?: number | null",
      "timeoutMs?: number | null",
      "env?: { [key in string]?: string | null } | null",
    ],
  },
  {
    file: "v2/CommandExecResponse.ts",
    snippets: ["exitCode: number", "stdout: string", "stderr: string"],
  },
  {
    file: "v2/ConfigBatchWriteParams.ts",
    snippets: [
      "edits: Array<ConfigEdit>",
      "filePath?: string | null",
      "expectedVersion?: string | null",
      "reloadUserConfig?: boolean",
    ],
  },
  {
    file: "v2/ConfigEdit.ts",
    snippets: ["keyPath: string", "value: JsonValue", "mergeStrategy: MergeStrategy"],
  },
  {
    file: "v2/ConfigValueWriteParams.ts",
    snippets: [
      "keyPath: string",
      "value: JsonValue",
      "mergeStrategy: MergeStrategy",
      "filePath?: string | null",
      "expectedVersion?: string | null",
    ],
  },
  {
    file: "v2/ConfigWriteResponse.ts",
    snippets: [
      "status: WriteStatus",
      "version: string",
      "filePath: AbsolutePathBuf",
      "overriddenMetadata: OverriddenMetadata | null",
    ],
  },
  {
    file: "v2/ConfigLayerSource.ts",
    snippets: ['type: "packagedDefaults"', "file: AbsolutePathBuf"],
  },
  {
    file: "v2/ConfigReadParams.ts",
    snippets: ["includeLayers?: boolean", "cwd?: string | null"],
  },
  {
    file: "v2/InstalledApp.ts",
    snippets: ["runtimeName: string | null", "enabled: boolean", "callable: boolean"],
  },
  {
    file: "v2/MarketplaceLoadErrorInfo.ts",
    snippets: ["marketplacePath: AbsolutePathBuf", "message: string"],
  },
  {
    file: "v2/MergeStrategy.ts",
    snippets: ['"replace"', '"upsert"'],
  },
  {
    file: "v2/OverriddenMetadata.ts",
    snippets: [
      "message: string",
      "overridingLayer: ConfigLayerMetadata",
      "effectiveValue: JsonValue",
    ],
  },
  {
    file: "v2/PluginSummary.ts",
    snippets: ["remotePluginId: string | null"],
  },
  {
    file: "v2/PluginListParams.ts",
    snippets: ["forceRefetch?: boolean"],
  },
  {
    file: "v2/PluginInstalledParams.ts",
    snippets: [
      "cwds?: Array<AbsolutePathBuf> | null",
      "installSuggestionPluginNames?: Array<string> | null",
    ],
  },
  {
    file: "v2/PluginInstalledResponse.ts",
    snippets: [
      "marketplaces: Array<PluginMarketplaceEntry>",
      "marketplaceLoadErrors: Array<MarketplaceLoadErrorInfo>",
    ],
  },
  {
    file: "v2/PluginListResponse.ts",
    snippets: [
      "marketplaces: Array<PluginMarketplaceEntry>",
      "marketplaceLoadErrors: Array<MarketplaceLoadErrorInfo>",
      "featuredPluginIds: Array<string>",
    ],
  },
  {
    file: "v2/PluginReadParams.ts",
    snippets: ["pluginName: string"],
  },
  {
    file: "v2/PluginReadResponse.ts",
    snippets: ["plugin: PluginDetail"],
  },
  {
    file: "v2/PluginInstallParams.ts",
    snippets: ["pluginName: string"],
  },
  {
    file: "v2/PluginInstallResponse.ts",
    snippets: ["appsNeedingAuth: Array<AppSummary>"],
  },
  {
    file: "v2/ThreadStartParams.ts",
    snippets: [
      "projectId?: string | null",
      "permissions?: string | null",
      "dynamicTools?: Array<DynamicToolSpec> | null",
      "experimentalRawEvents",
    ],
  },
  {
    file: "v2/Thread.ts",
    snippets: ["projectId: string | null"],
  },
  {
    file: "v2/Model.ts",
    snippets: ["multiAgentVersion: MultiAgentVersion | null"],
  },
  {
    file: "v2/CodexErrorInfo.ts",
    snippets: ['"misalignmentPolicyViolation"'],
  },
  {
    file: "v2/McpResourceReadParams.ts",
    snippets: [
      "threadId?: string | null",
      "originCallId?: string | null",
      "connectorId?: string | null",
    ],
  },
  {
    file: "v2/McpResourceReadResponse.ts",
    snippets: ["originCallId: string | null"],
  },
  {
    file: "v2/StrictReviewRequiredNotification.ts",
    snippets: ["threadId: string", "turnId: string", "startedAtMs: number"],
  },
  {
    file: "v2/AgentMessageDelivery.ts",
    snippets: ['"async"'],
  },
  {
    file: "v2/TurnStartParams.ts",
    snippets: ["permissions?: string | null", "serviceTier?: string | null"],
  },
  {
    file: "v2/WriteStatus.ts",
    snippets: ['"ok"', '"okOverridden"'],
  },
  {
    file: "ReviewDecision.ts",
    snippets: ['"approved"', '"approved_for_session"', "denied: { rejection: string }", '"abort"'],
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
await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main(): Promise<void> {
  const source = await generateExperimentalCodexAppServerProtocolSource();

  try {
    await compareGeneratedProtocolMirror(source.jsonRoot);
    await checkMaintainedProtocolTypes(source.typescriptRoot);

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
}

async function checkMaintainedProtocolTypes(sourceRoot: string): Promise<void> {
  // Raw requests go to Codex; raw responses flow into OpenClaw. Keep the
  // assignability direction explicit so the probe permits deliberate projections.
  const probePath = path.join(sourceRoot, "openclaw-protocol-compatibility.ts");
  const protocolPath = path.resolve(process.cwd(), "extensions/codex/src/app-server/protocol.ts");
  const protocolImport = relativeTypeScriptImport(probePath, protocolPath);
  const generatedImport = (file: string) =>
    relativeTypeScriptImport(probePath, path.join(sourceRoot, file));
  const probe = `
import type {
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
  CodexConfigEdit,
  CodexDynamicToolSpec,
  CodexDynamicToolCallParams,
  CodexErrorNotification,
  CodexGetAccountResponse,
  CodexModelListResponse,
  CodexServerNotification,
  CodexThreadForkResponse,
  CodexThreadResumeResponse,
  CodexThreadStartResponse,
  CodexTurnEnvironmentParams,
  v2,
} from ${JSON.stringify(protocolImport)};
import type { AppSummary } from ${JSON.stringify(generatedImport("v2/AppSummary.ts"))};
import type { AppsInstalledParams } from ${JSON.stringify(generatedImport("v2/AppsInstalledParams.ts"))};
import type { AppsInstalledResponse } from ${JSON.stringify(generatedImport("v2/AppsInstalledResponse.ts"))};
import type { AppsListParams } from ${JSON.stringify(generatedImport("v2/AppsListParams.ts"))};
import type { AppsListResponse } from ${JSON.stringify(generatedImport("v2/AppsListResponse.ts"))};
import type { AppsReadParams } from ${JSON.stringify(generatedImport("v2/AppsReadParams.ts"))};
import type { AppsReadResponse } from ${JSON.stringify(generatedImport("v2/AppsReadResponse.ts"))};
import type { CommandExecParams } from ${JSON.stringify(generatedImport("v2/CommandExecParams.ts"))};
import type { CommandExecResponse } from ${JSON.stringify(generatedImport("v2/CommandExecResponse.ts"))};
import type { ConfigBatchWriteParams } from ${JSON.stringify(generatedImport("v2/ConfigBatchWriteParams.ts"))};
import type { ConfigEdit } from ${JSON.stringify(generatedImport("v2/ConfigEdit.ts"))};
import type { ConfigValueWriteParams } from ${JSON.stringify(generatedImport("v2/ConfigValueWriteParams.ts"))};
import type { ConfigWriteResponse } from ${JSON.stringify(generatedImport("v2/ConfigWriteResponse.ts"))};
import type { DynamicToolCallParams } from ${JSON.stringify(generatedImport("v2/DynamicToolCallParams.ts"))};
import type { DynamicToolSpec } from ${JSON.stringify(generatedImport("v2/DynamicToolSpec.ts"))};
import type { ErrorNotification } from ${JSON.stringify(generatedImport("v2/ErrorNotification.ts"))};
import type { ConfigReadParams } from ${JSON.stringify(generatedImport("v2/ConfigReadParams.ts"))};
import type { GetAccountResponse } from ${JSON.stringify(generatedImport("v2/GetAccountResponse.ts"))};
import type { MarketplaceLoadErrorInfo } from ${JSON.stringify(generatedImport("v2/MarketplaceLoadErrorInfo.ts"))};
import type { McpResourceReadParams } from ${JSON.stringify(generatedImport("v2/McpResourceReadParams.ts"))};
import type { McpResourceReadResponse } from ${JSON.stringify(generatedImport("v2/McpResourceReadResponse.ts"))};
import type { ModelListResponse } from ${JSON.stringify(generatedImport("v2/ModelListResponse.ts"))};
import type { PluginInstalledParams } from ${JSON.stringify(generatedImport("v2/PluginInstalledParams.ts"))};
import type { PluginInstalledResponse } from ${JSON.stringify(generatedImport("v2/PluginInstalledResponse.ts"))};
import type { PluginInstallParams } from ${JSON.stringify(generatedImport("v2/PluginInstallParams.ts"))};
import type { PluginInstallResponse } from ${JSON.stringify(generatedImport("v2/PluginInstallResponse.ts"))};
import type { PluginListParams } from ${JSON.stringify(generatedImport("v2/PluginListParams.ts"))};
import type { PluginListResponse } from ${JSON.stringify(generatedImport("v2/PluginListResponse.ts"))};
import type { PluginReadParams } from ${JSON.stringify(generatedImport("v2/PluginReadParams.ts"))};
import type { PluginReadResponse } from ${JSON.stringify(generatedImport("v2/PluginReadResponse.ts"))};
import type { ThreadDeleteParams } from ${JSON.stringify(generatedImport("v2/ThreadDeleteParams.ts"))};
import type { ThreadDeleteResponse } from ${JSON.stringify(generatedImport("v2/ThreadDeleteResponse.ts"))};
import type { ThreadForkParams } from ${JSON.stringify(generatedImport("v2/ThreadForkParams.ts"))};
import type { ThreadForkResponse } from ${JSON.stringify(generatedImport("v2/ThreadForkResponse.ts"))};
import type { ThreadResumeParams } from ${JSON.stringify(generatedImport("v2/ThreadResumeParams.ts"))};
import type { ThreadResumeResponse } from ${JSON.stringify(generatedImport("v2/ThreadResumeResponse.ts"))};
import type { ThreadStartParams } from ${JSON.stringify(generatedImport("v2/ThreadStartParams.ts"))};
import type { ThreadStartResponse } from ${JSON.stringify(generatedImport("v2/ThreadStartResponse.ts"))};
import type { StrictReviewRequiredNotification } from ${JSON.stringify(generatedImport("v2/StrictReviewRequiredNotification.ts"))};
import type { TurnEnvironmentParams } from ${JSON.stringify(generatedImport("v2/TurnEnvironmentParams.ts"))};
import type { TurnInterruptParams } from ${JSON.stringify(generatedImport("v2/TurnInterruptParams.ts"))};
import type { TurnStartParams } from ${JSON.stringify(generatedImport("v2/TurnStartParams.ts"))};
import type { TurnSteerParams } from ${JSON.stringify(generatedImport("v2/TurnSteerParams.ts"))};
import type { TurnSteerResponse } from ${JSON.stringify(generatedImport("v2/TurnSteerResponse.ts"))};

declare const openClawAppsInstalledParams: CodexAppServerRequestParams<"app/installed">;
const generatedAppsInstalledParams: AppsInstalledParams = openClawAppsInstalledParams;
declare const openClawAppsListParams: CodexAppServerRequestParams<"app/list">;
const generatedAppsListParams: AppsListParams = openClawAppsListParams;
declare const openClawAppsReadParams: CodexAppServerRequestParams<"app/read">;
const generatedAppsReadParams: AppsReadParams = openClawAppsReadParams;
declare const openClawAppSummary: v2.AppSummary;
const generatedAppSummary: AppSummary = openClawAppSummary;
declare const openClawCommandExecParams: CodexAppServerRequestParams<"command/exec">;
const generatedCommandExecParams: CommandExecParams = openClawCommandExecParams;
declare const generatedNullableCommandExecParams: CommandExecParams;
const openClawNullableCommandExecParams: CodexAppServerRequestParams<"command/exec"> =
  generatedNullableCommandExecParams;
declare const openClawConfigBatchWriteParams: CodexAppServerRequestParams<"config/batchWrite">;
const generatedConfigBatchWriteParams: ConfigBatchWriteParams = openClawConfigBatchWriteParams;
declare const openClawConfigEdit: CodexConfigEdit;
const generatedConfigEdit: ConfigEdit = openClawConfigEdit;
declare const openClawConfigValueWriteParams: CodexAppServerRequestParams<"config/value/write">;
const generatedConfigValueWriteParams: ConfigValueWriteParams = openClawConfigValueWriteParams;
declare const openClawPluginInstalledParams: CodexAppServerRequestParams<"plugin/installed">;
const generatedPluginInstalledParams: PluginInstalledParams = openClawPluginInstalledParams;
declare const openClawPluginInstallParams: CodexAppServerRequestParams<"plugin/install">;
const generatedPluginInstallParams: PluginInstallParams = openClawPluginInstallParams;
declare const openClawPluginListParams: CodexAppServerRequestParams<"plugin/list">;
const generatedPluginListParams: PluginListParams = openClawPluginListParams;
declare const openClawPluginReadParams: CodexAppServerRequestParams<"plugin/read">;
const generatedPluginReadParams: PluginReadParams = openClawPluginReadParams;
declare const openClawDynamicToolSpec: CodexDynamicToolSpec;
const generatedDynamicToolSpec: DynamicToolSpec = openClawDynamicToolSpec;
declare const openClawTurnEnvironmentParams: CodexTurnEnvironmentParams;
const generatedTurnEnvironmentParams: TurnEnvironmentParams = openClawTurnEnvironmentParams;
declare const openClawThreadStartParams: CodexAppServerRequestParams<"thread/start">;
const generatedThreadStartParams: ThreadStartParams = openClawThreadStartParams;
declare const openClawThreadResumeParams: CodexAppServerRequestParams<"thread/resume">;
const generatedThreadResumeParams: ThreadResumeParams = openClawThreadResumeParams;
declare const openClawThreadForkParams: CodexAppServerRequestParams<"thread/fork">;
const generatedThreadForkParams: ThreadForkParams = openClawThreadForkParams;
declare const openClawThreadDeleteParams: CodexAppServerRequestParams<"thread/delete">;
const generatedThreadDeleteParams: ThreadDeleteParams = openClawThreadDeleteParams;
declare const openClawTurnInterruptParams: CodexAppServerRequestParams<"turn/interrupt">;
const generatedTurnInterruptParams: TurnInterruptParams = openClawTurnInterruptParams;
declare const openClawTurnStartParams: CodexAppServerRequestParams<"turn/start">;
const generatedTurnStartParams: TurnStartParams = openClawTurnStartParams;
declare const openClawTurnSteerParams: CodexAppServerRequestParams<"turn/steer">;
const generatedTurnSteerParams: TurnSteerParams = openClawTurnSteerParams;
// Method-map omissions must not silently weaken required wire fields to unknown.
// @ts-expect-error Thread resume requires its target thread.
const threadResumeWithoutThread: CodexAppServerRequestParams<"thread/resume"> = {};
// @ts-expect-error Starting a turn requires its input.
const turnStartWithoutInput: CodexAppServerRequestParams<"turn/start"> = { threadId: "thread" };
// @ts-expect-error Steering requires the active-turn precondition.
const turnSteerWithoutExpectedTurn: CodexAppServerRequestParams<"turn/steer"> = { threadId: "thread", input: [] };
declare const openClawMcpResourceReadParams: CodexAppServerRequestParams<"mcpServer/resource/read">;
const generatedMcpResourceReadParams: McpResourceReadParams = openClawMcpResourceReadParams;
declare const openClawConfigReadParams: CodexAppServerRequestParams<"config/read">;
const generatedConfigReadParams: ConfigReadParams = openClawConfigReadParams;

declare const generatedAppsInstalledResponse: AppsInstalledResponse;
const openClawAppsInstalledResponse: CodexAppServerRequestResult<"app/installed"> =
  generatedAppsInstalledResponse;
declare const generatedAppsListResponse: AppsListResponse;
const openClawAppsListResponse: CodexAppServerRequestResult<"app/list"> =
  generatedAppsListResponse;
declare const generatedAppsReadResponse: AppsReadResponse;
const openClawAppsReadResponse: CodexAppServerRequestResult<"app/read"> =
  generatedAppsReadResponse;
declare const generatedAppSummaryResponse: AppSummary;
const openClawAppSummaryResponse: v2.AppSummary = generatedAppSummaryResponse;
declare const generatedCommandExecResponse: CommandExecResponse;
const openClawCommandExecResponse: CodexAppServerRequestResult<"command/exec"> =
  generatedCommandExecResponse;
declare const generatedConfigWriteResponse: ConfigWriteResponse;
const openClawConfigBatchWriteResponse: CodexAppServerRequestResult<"config/batchWrite"> =
  generatedConfigWriteResponse;
const openClawConfigValueWriteResponse: CodexAppServerRequestResult<"config/value/write"> =
  generatedConfigWriteResponse;
const generatedExactConfigBatchWriteResponse: ConfigWriteResponse =
  openClawConfigBatchWriteResponse;
const generatedExactConfigValueWriteResponse: ConfigWriteResponse =
  openClawConfigValueWriteResponse;
declare const generatedPluginInstalledResponse: PluginInstalledResponse;
const openClawPluginInstalledResponse: CodexAppServerRequestResult<"plugin/installed"> =
  generatedPluginInstalledResponse;
const generatedPluginInstalledMarketplaceLoadErrors: MarketplaceLoadErrorInfo[] =
  openClawPluginInstalledResponse.marketplaceLoadErrors;
type InstalledPluginResponseHasNoFeaturedCatalog =
  "featuredPluginIds" extends keyof v2.PluginInstalledResponse ? never : true;
const installedPluginResponseHasNoFeaturedCatalog: InstalledPluginResponseHasNoFeaturedCatalog =
  true;
declare const generatedPluginInstallResponse: PluginInstallResponse;
const openClawPluginInstallResponse: CodexAppServerRequestResult<"plugin/install"> =
  generatedPluginInstallResponse;
declare const generatedPluginListResponse: PluginListResponse;
const openClawPluginListResponse: CodexAppServerRequestResult<"plugin/list"> =
  generatedPluginListResponse;
const generatedPluginListMarketplaceLoadErrors: MarketplaceLoadErrorInfo[] =
  openClawPluginListResponse.marketplaceLoadErrors;
const generatedPluginListFeaturedPluginIds: string[] = openClawPluginListResponse.featuredPluginIds;
declare const generatedPluginReadResponse: PluginReadResponse;
const openClawPluginReadResponse: CodexAppServerRequestResult<"plugin/read"> =
  generatedPluginReadResponse;
declare const generatedDynamicToolCallParams: Omit<DynamicToolCallParams, "arguments">;
const openClawDynamicToolCallParams: Omit<CodexDynamicToolCallParams, "arguments"> =
  generatedDynamicToolCallParams;
declare const generatedErrorNotification: ErrorNotification;
const openClawErrorNotification: CodexErrorNotification = generatedErrorNotification;
declare const generatedGetAccountResponse: GetAccountResponse;
const openClawGetAccountResponse: CodexGetAccountResponse = generatedGetAccountResponse;
declare const generatedModelListResponse: ModelListResponse;
const openClawModelListResponse: CodexModelListResponse = generatedModelListResponse;
declare const generatedMcpResourceReadResponse: McpResourceReadResponse;
const openClawMcpResourceReadResponse: CodexAppServerRequestResult<"mcpServer/resource/read"> =
  generatedMcpResourceReadResponse;
declare const generatedStrictReviewRequiredNotification: StrictReviewRequiredNotification;
type OpenClawStrictReviewRequiredNotification = Extract<
  CodexServerNotification,
  { method: "autoApprovalReview/strictReviewRequired" }
>;
const openClawStrictReviewRequiredNotification: OpenClawStrictReviewRequiredNotification = {
  method: "autoApprovalReview/strictReviewRequired",
  params: generatedStrictReviewRequiredNotification,
};
declare const generatedThreadDeleteResponse: ThreadDeleteResponse;
const openClawThreadDeleteResponse: CodexAppServerRequestResult<"thread/delete"> =
  generatedThreadDeleteResponse;
declare const generatedTurnSteerResponse: TurnSteerResponse;
const openClawTurnSteerResponse: CodexAppServerRequestResult<"turn/steer"> =
  generatedTurnSteerResponse;
const generatedExactTurnSteerResponse: TurnSteerResponse = openClawTurnSteerResponse;

// Thread and turn bodies are normalized behind checked-in JSON schemas. Their
// raw generated shapes must not be confused with the projector-facing types.
declare const generatedThreadForkResponse: Omit<ThreadForkResponse, "thread">;
const openClawThreadForkResponse: Omit<CodexThreadForkResponse, "thread"> =
  generatedThreadForkResponse;
declare const generatedThreadResumeResponse: Omit<ThreadResumeResponse, "thread">;
const openClawThreadResumeResponse: Omit<CodexThreadResumeResponse, "thread"> =
  generatedThreadResumeResponse;
declare const generatedThreadStartResponse: Omit<ThreadStartResponse, "thread">;
const openClawThreadStartResponse: Omit<CodexThreadStartResponse, "thread"> =
  generatedThreadStartResponse;

export {};
`;
  await fs.writeFile(probePath, probe);
  const probeConfigPath = path.join(sourceRoot, "openclaw-protocol-compatibility.tsconfig.json");
  await fs.writeFile(
    probeConfigPath,
    JSON.stringify({
      extends: path.resolve("tsconfig.json"),
      compilerOptions: { rootDir: process.cwd() },
      files: [probePath],
      include: [],
    }),
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/run-tsgo.mjs", "--project", probeConfigPath],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.error) {
    failures.push(`maintained protocol types: failed to start tsgo (${result.error.message})`);
    return;
  }
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim();
    failures.push(`maintained protocol types differ from generated Codex types\n${output}`);
  }
}

function relativeTypeScriptImport(fromFile: string, toFile: string): string {
  const relative = path.relative(path.dirname(fromFile), toFile).replaceAll(path.sep, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

async function compareGeneratedProtocolMirror(sourceJsonRoot: string): Promise<void> {
  const sourceSchemas = new Map<string, unknown>();
  for (const schema of selectedCodexAppServerJsonSchemas) {
    const sourcePath = path.join(sourceJsonRoot, schema);
    try {
      sourceSchemas.set(schema, JSON.parse(await fs.readFile(sourcePath, "utf8")));
    } catch (error) {
      failures.push(
        `protocol-generated/json/${schema}: missing upstream schema (${String(error)})`,
      );
    }
  }
  if (sourceSchemas.size !== selectedCodexAppServerJsonSchemas.length) {
    return;
  }

  const expected = compactCodexAppServerProtocolJsonSchemas(sourceSchemas);
  const local = new Map<string, unknown>();
  for (const [schema, expectedValue] of expected) {
    const targetPath = path.join(generatedRoot, "json", schema);
    try {
      const target = await fs.readFile(targetPath, "utf8");
      local.set(schema, JSON.parse(target));
      if (normalizeJsonSchema(JSON.stringify(expectedValue)) !== normalizeJsonSchema(target)) {
        failures.push(`protocol-generated/json/${schema}: differs from compacted source schema`);
      }
    } catch (error) {
      failures.push(`protocol-generated/json/${schema}: missing local schema (${String(error)})`);
    }
  }

  const sharedSchema = local.get(codexAppServerSharedDefinitionsSchema);
  if (sharedSchema === undefined) {
    return;
  }
  for (const schema of selectedCodexAppServerJsonSchemas) {
    const compactSchema = local.get(schema);
    const sourceSchema = sourceSchemas.get(schema);
    if (compactSchema === undefined || sourceSchema === undefined) {
      continue;
    }
    try {
      const expanded = expandCodexAppServerProtocolJsonSchema({
        schema: compactSchema,
        schemaPath: schema,
        sharedSchema,
      });
      if (
        normalizeJsonSchema(JSON.stringify(expanded)) !==
        normalizeJsonSchema(JSON.stringify(sourceSchema))
      ) {
        failures.push(
          `protocol-generated/json/${schema}: compact schema does not expand to its source schema`,
        );
      }
    } catch (error) {
      failures.push(`protocol-generated/json/${schema}: cannot expand (${String(error)})`);
    }
  }
}

function normalizeJsonSchema(sourceLocal: string): string {
  return normalizeCodexAppServerProtocolJsonText(sourceLocal);
}
