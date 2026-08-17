import type { ResolveSecureTempRoot } from "../infra/secure-temp-root.js";

type WorkerDeployRuntime = {
  highlightJs?: unknown;
  json5?: unknown;
  resolveSecureTempRoot?: ResolveSecureTempRoot;
};

const runtime: WorkerDeployRuntime = {};

export function setWorkerDeployRuntime(next: Required<WorkerDeployRuntime>): void {
  runtime.highlightJs = next.highlightJs;
  runtime.json5 = next.json5;
  runtime.resolveSecureTempRoot = next.resolveSecureTempRoot;
}

export function getWorkerDeployHighlightJs(): unknown {
  return runtime.highlightJs;
}

export function getWorkerDeployJson5(): unknown {
  return runtime.json5;
}

export function getWorkerDeploySecureTempRoot(): ResolveSecureTempRoot | undefined {
  return runtime.resolveSecureTempRoot;
}
