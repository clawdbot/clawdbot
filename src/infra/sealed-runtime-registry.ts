import type { ResolveSecureTempRoot } from "./secure-temp-root.js";

type SealedRuntime = { json5: unknown; resolveSecureTempRoot: ResolveSecureTempRoot };
let runtime: SealedRuntime | undefined;

export function registerSealedRuntime(next: SealedRuntime): void {
  runtime = next;
}

export function getSealedRuntimeJson5(): unknown {
  return runtime?.json5;
}

export function getSealedRuntimeSecureTempRoot(): ResolveSecureTempRoot | undefined {
  return runtime?.resolveSecureTempRoot;
}
