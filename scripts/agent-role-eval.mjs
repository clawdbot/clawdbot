#!/usr/bin/env node
import process from "node:process";
import {
  AGENT_ROLE_CONTRACTS,
  AGENT_ROLE_CONTRACT_BY_ID,
  DEFAULT_SELF_CONTAINED_LIVE_MODEL,
  createSelfContainedLiveEvalEnvironment,
  defaultConfigPath,
  evaluateAgentRoleContractCatalog,
  evaluateAgentStaticContracts,
  loadConfigFile,
  runLiveAgentEval,
} from "./lib/agent-role-evals.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/agent-role-eval.mjs [--config <path>] [--agent <id>] [--json]",
    "  node scripts/agent-role-eval.mjs --contracts-only [--json]",
    "  node scripts/agent-role-eval.mjs --live [--agent <id>] [--model <id>] [--timeout <seconds>] [--self-contained] [--json]",
    "",
    "Default mode runs deterministic static contract checks. Use --agent to check one configured agent.",
    "--contracts-only validates the checked-in role contract catalog without private local agent state.",
    "--live runs real local agent turns against the same role contracts.",
    "--self-contained creates temporary agent workspaces/config/state for live evals.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    configPath: defaultConfigPath(),
    json: false,
    live: false,
    contractsOnly: false,
    selfContained: false,
    keepSelfContainedState: false,
    timeoutSeconds: 480,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--config") {
      args.configPath = argv[++index];
    } else if (arg === "--agent") {
      args.agentId = argv[++index];
    } else if (arg === "--model") {
      args.model = argv[++index];
    } else if (arg === "--timeout") {
      args.timeoutSeconds = Number(argv[++index]);
    } else if (arg === "--live") {
      args.live = true;
    } else if (arg === "--self-contained") {
      args.selfContained = true;
    } else if (arg === "--keep-self-contained-state") {
      args.keepSelfContainedState = true;
    } else if (arg === "--contracts-only") {
      args.contractsOnly = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.timeoutSeconds) || args.timeoutSeconds <= 0) {
    throw new Error("--timeout must be a positive number of seconds");
  }
  if (args.selfContained && !args.live) {
    throw new Error("--self-contained is only supported with --live");
  }
  return args;
}

function printCatalogText(result) {
  console.log(`Agent role contract catalog: ${result.ok ? "passed" : "failed"}`);
  console.log(`Contracts checked: ${result.contractCount}`);
  console.log(`Critical contracts required: ${result.criticalContractCount}`);
  if (result.issues.length > 0) {
    console.log("");
    for (const issue of result.issues) {
      console.log(`- [${issue.severity}] ${issue.agentId} ${issue.code}: ${issue.message}`);
    }
  }
}

function printStaticText(result) {
  console.log(`Agent role static eval: ${result.ok ? "passed" : "failed"}`);
  console.log(`Agents checked: ${result.agentCount}`);
  console.log(`Contracts available: ${result.contractCount}`);
  if (result.issues.length > 0) {
    console.log("");
    for (const issue of result.issues) {
      console.log(`- [${issue.severity}] ${issue.agentId} ${issue.code}: ${issue.message}`);
    }
  }
}

function printLiveText(results) {
  const failed = results.filter((entry) => !entry.ok);
  console.log(`Agent role live eval: ${failed.length === 0 ? "passed" : "failed"}`);
  console.log(`Agents checked: ${results.length}`);
  for (const result of results) {
    const model = result.provider && result.model ? ` ${result.provider}/${result.model}` : "";
    const duration = result.durationMs ? ` ${result.durationMs}ms` : "";
    console.log(`- ${result.ok ? "PASS" : "FAIL"} ${result.agentId}${model}${duration}`);
    if (!result.ok) {
      const detail = result.error ?? result.evaluation?.issues?.join("; ") ?? "unknown failure";
      console.log(`  ${detail}`);
    }
  }
}

function runCatalog(args) {
  const result = evaluateAgentRoleContractCatalog();
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printCatalogText(result);
  }
  process.exitCode = result.ok ? 0 : 1;
}

function runStatic(args) {
  const config = loadConfigFile(args.configPath);
  const result = evaluateAgentStaticContracts(config, {
    agentId: args.agentId,
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printStaticText(result);
  }
  process.exitCode = result.ok ? 0 : 1;
}

function runLive(args) {
  const contracts = args.agentId
    ? [AGENT_ROLE_CONTRACT_BY_ID.get(args.agentId)].filter(Boolean)
    : AGENT_ROLE_CONTRACTS;
  if (args.agentId && contracts.length === 0) {
    throw new Error(`No role eval contract exists for ${args.agentId}`);
  }
  let fixture;
  let model = args.model;
  let staticResult;
  if (args.selfContained) {
    model =
      model ??
      process.env.OPENCLAW_AGENT_ROLE_EVAL_MODEL ??
      process.env.OPENCLAW_AGENT_EVAL_LIVE_MODEL ??
      DEFAULT_SELF_CONTAINED_LIVE_MODEL;
    fixture = createSelfContainedLiveEvalEnvironment(contracts, {
      modelRef: model,
      keep: args.keepSelfContainedState,
    });
    staticResult = evaluateAgentStaticContracts(fixture.config, {
      stateDir: fixture.stateDir,
    });
    if (!staticResult.ok) {
      const result = { ok: false, selfContained: true, staticResult, results: [] };
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printStaticText(staticResult);
      }
      process.exitCode = 1;
      fixture.cleanup();
      return;
    }
  }

  try {
    const results = contracts.map((contract) =>
      runLiveAgentEval(contract, {
        model,
        timeoutSeconds: args.timeoutSeconds,
        env: fixture?.env,
      }),
    );
    const ok = results.every((entry) => entry.ok);
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            ok,
            selfContained: Boolean(fixture),
            ...(staticResult ? { staticResult } : {}),
            results,
          },
          null,
          2,
        ),
      );
    } else {
      if (fixture) {
        console.log(`Self-contained live eval state: prepared (${model})`);
      }
      printLiveText(results);
    }
    process.exitCode = ok ? 0 : 1;
  } finally {
    fixture?.cleanup();
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
  } else if (args.contractsOnly) {
    runCatalog(args);
  } else if (args.live) {
    runLive(args);
  } else {
    runStatic(args);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
