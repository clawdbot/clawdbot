import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { QaTransportState } from "./qa-transport.js";
import type { QaScenarioFlow, QaSeedScenarioWithSource } from "./scenario-catalog.js";

type QaSuiteStep = {
  name: string;
  run: () => Promise<string | void>;
};

type QaSuiteScenarioResult = {
  name: string;
  status: "pass" | "fail";
  steps: Array<{
    name: string;
    status: "pass" | "fail" | "skip";
    details?: string;
  }>;
  details?: string;
};

type QaFlowApi = Record<string, unknown> & {
  state: QaTransportState;
  scenario: QaSeedScenarioWithSource;
  config: Record<string, unknown>;
  runScenario: (name: string, steps: QaSuiteStep[]) => Promise<QaSuiteScenarioResult>;
};

type QaFlowVars = Record<string, unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...fnArgs: unknown[]) => Promise<unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatFlowDetails(details: unknown) {
  if (details === undefined) {
    return undefined;
  }
  if (typeof details === "string") {
    return details;
  }
  if (typeof details === "number" || typeof details === "boolean" || typeof details === "bigint") {
    return String(details);
  }
  return JSON.stringify(details, null, 2);
}

function getPathWithParent(
  root: Record<string, unknown>,
  ref: string,
): { parent: Record<string, unknown> | null; value: unknown } {
  const parts = ref.split(".").filter(Boolean);
  let current: unknown = root;
  let parent: Record<string, unknown> | null = null;
  for (const part of parts) {
    if (!isPlainObject(current)) {
      return { parent: null, value: undefined };
    }
    parent = current;
    current = current[part];
  }
  return { parent, value: current };
}

function createEvalContext(api: QaFlowApi, vars: QaFlowVars) {
  return {
    ...api,
    vars,
    ...vars,
  };
}

async function evalExpr(expr: string, api: QaFlowApi, vars: QaFlowVars) {
  const context = createEvalContext(api, vars);
  const names = Object.keys(context);
  const values = Object.values(context);
  const fn = new AsyncFunction(...names, `return (${expr});`);
  return await fn(...values);
}

function buildLambda(
  spec: { params?: string[]; expr: string; async?: boolean },
  api: QaFlowApi,
  vars: QaFlowVars,
) {
  const context = createEvalContext(api, vars);
  const names = Object.keys(context);
  const values = Object.values(context);
  const params = spec.params ?? [];
  const Factory = spec.async ? AsyncFunction : Function;
  const fn = new Factory(...names, ...params, `return (${spec.expr});`) as (
    ...fnArgs: unknown[]
  ) => unknown;
  return (...lambdaArgs: unknown[]) => fn(...values, ...lambdaArgs);
}

async function resolveValue(node: unknown, api: QaFlowApi, vars: QaFlowVars): Promise<unknown> {
  if (Array.isArray(node)) {
    return await Promise.all(node.map((entry) => resolveValue(entry, api, vars)));
  }
  if (!isPlainObject(node)) {
    return node;
  }
  const keys = Object.keys(node);
  if (keys.length === 1 && typeof node.ref === "string") {
    return getPathWithParent(createEvalContext(api, vars), node.ref).value;
  }
  if (keys.length === 1 && typeof node.expr === "string") {
    return await evalExpr(node.expr, api, vars);
  }
  if (keys.length === 1 && isPlainObject(node.lambda) && typeof node.lambda.expr === "string") {
    return buildLambda(
      {
        expr: node.lambda.expr,
        params: Array.isArray(node.lambda.params)
          ? node.lambda.params.filter((entry): entry is string => typeof entry === "string")
          : [],
        async: node.lambda.async === true,
      },
      api,
      vars,
    );
  }
  const entries = await Promise.all(
    Object.entries(node).map(async ([key, value]) => [key, await resolveValue(value, api, vars)]),
  );
  return Object.fromEntries(entries);
}

function resolveCallable(path: string, api: QaFlowApi, vars: QaFlowVars) {
  const { parent, value } = getPathWithParent(createEvalContext(api, vars), path);
  if (typeof value !== "function") {
    throw new Error(`qa flow callable not found: ${path}`);
  }
  return parent ? value.bind(parent) : value;
}

async function runFlowAction(action: unknown, api: QaFlowApi, vars: QaFlowVars) {
  if (!isPlainObject(action)) {
    throw new Error(`invalid qa flow action: ${JSON.stringify(action)}`);
  }
  if (typeof action.call === "string") {
    const callable = resolveCallable(action.call, api, vars);
    const args = Array.isArray(action.args)
      ? await Promise.all(action.args.map((entry) => resolveValue(entry, api, vars)))
      : [];
    const result = await callable(...args);
    if (typeof action.saveAs === "string" && action.saveAs.trim()) {
      vars[action.saveAs.trim()] = result;
    }
    return;
  }
  if (typeof action.set === "string") {
    vars[action.set] = await resolveValue(action.value, api, vars);
    return;
  }
  if (typeof action.assert === "string" || isPlainObject(action.assert)) {
    const spec =
      typeof action.assert === "string"
        ? { expr: action.assert, message: undefined }
        : {
            expr: typeof action.assert.expr === "string" ? action.assert.expr : "",
            message: action.assert.message,
          };
    if (!spec.expr) {
      throw new Error(`invalid qa flow assertion: ${JSON.stringify(action.assert)}`);
    }
    const passed = Boolean(await evalExpr(spec.expr, api, vars));
    if (!passed) {
      const message =
        spec.message === undefined ? undefined : await resolveValue(spec.message, api, vars);
      throw new Error(
        typeof message === "string" && message.trim()
          ? message
          : `qa flow assertion failed: ${spec.expr}`,
      );
    }
    return;
  }
  if (typeof action.throw === "string" || isPlainObject(action.throw)) {
    const spec =
      typeof action.throw === "string"
        ? { expr: undefined, message: action.throw }
        : {
            expr: typeof action.throw.expr === "string" ? action.throw.expr : undefined,
            message: action.throw.message,
          };
    const evaluated = spec.expr ? await evalExpr(spec.expr, api, vars) : undefined;
    const message =
      spec.message === undefined ? undefined : await resolveValue(spec.message, api, vars);
    if (evaluated instanceof Error) {
      throw evaluated;
    }
    if (typeof evaluated === "string" && evaluated.trim()) {
      throw new Error(evaluated);
    }
    if (typeof message === "string" && message.trim()) {
      throw new Error(message);
    }
    throw new Error("qa flow throw");
  }
  if (isPlainObject(action.if)) {
    const ifAction = action.if as { expr: string; then: unknown[]; else?: unknown[] };
    const passed = Boolean(await evalExpr(ifAction.expr, api, vars));
    const branch = passed ? ifAction.then : (ifAction.else ?? []);
    for (const nested of branch) {
      await runFlowAction(nested, api, vars);
    }
    return;
  }
  if (isPlainObject(action.forEach)) {
    const forEachAction = action.forEach as {
      items: unknown;
      item: string;
      index?: string;
      actions: unknown[];
    };
    const items = await resolveValue(forEachAction.items, api, vars);
    if (!Array.isArray(items)) {
      throw new Error(`qa flow forEach items must resolve to array: ${JSON.stringify(items)}`);
    }
    for (const [index, item] of items.entries()) {
      vars[forEachAction.item] = item;
      if (forEachAction.index) {
        vars[forEachAction.index] = index;
      }
      for (const nested of forEachAction.actions) {
        await runFlowAction(nested, api, vars);
      }
    }
    return;
  }
  if (isPlainObject(action.try)) {
    const tryAction = action.try as {
      actions: unknown[];
      catchAs?: string;
      catch?: unknown[];
      finally?: unknown[];
    };
    try {
      for (const nested of tryAction.actions) {
        await runFlowAction(nested, api, vars);
      }
    } catch (error) {
      if (!tryAction.catch && !tryAction.finally) {
        throw error;
      }
      if (tryAction.catchAs) {
        vars[tryAction.catchAs] = error;
      }
      if (tryAction.catch) {
        for (const nested of tryAction.catch) {
          await runFlowAction(nested, api, vars);
        }
      } else {
        throw error;
      }
    } finally {
      if (tryAction.finally) {
        for (const nested of tryAction.finally) {
          await runFlowAction(nested, api, vars);
        }
      }
    }
    return;
  }
  throw new Error(`unknown qa flow action: ${JSON.stringify(action)}`);
}

export async function runScenarioFlow(params: {
  api: QaFlowApi;
  flow: QaScenarioFlow;
  scenarioTitle: string;
}) {
  const vars: QaFlowVars = {};
  const steps: QaSuiteStep[] = params.flow.steps.map((step) => ({
    name: step.name,
    run: async () => {
      for (const action of step.actions) {
        await runFlowAction(action, params.api, vars);
      }
      if (!step.detailsExpr) {
        return undefined;
      }
      const details = await evalExpr(step.detailsExpr, params.api, vars);
      return formatFlowDetails(details);
    },
  }));
  return await params.api.runScenario(params.scenarioTitle, steps);
}

export function describeScenarioFlowError(error: unknown) {
  return formatErrorMessage(error);
}
