/**
 * Bindings between a model provider and the app-server agent-harness runtime
 * that serves it. These are the non-CLI parallel of the CLI runtime bindings in
 * `cli-backends.ts`, and they drive the runtime chooser `/models` offers for a
 * provider.
 *
 * Why this list is explicit rather than derived:
 *
 * - A CLI backend declares `modelProvider` on its own registration, so
 *   `listCliRuntimeModelBackendBindings()` can read the pairing straight off the
 *   registry. An `AgentHarness` registration carries no such declaration, so
 *   there is nothing equivalent to read.
 * - Harness plugins ship `activation.onStartup: false` with
 *   `activation.onAgentHarnesses`, which means they are only imported once an
 *   agent is already configured to use them. Deriving these bindings from the
 *   live harness registry would therefore hide each runtime from the chooser
 *   until the user had already selected it — removing the discovery path the
 *   chooser exists to provide.
 * - Manifest metadata carries the harness id but not the provider it serves.
 *   `sessionRouteStateOwners.providerIds` is close but is not the same fact:
 *   the Codex harness owns `codex`/`codex-cli`/`openai-codex` session route
 *   state while serving the `openai` model provider.
 *
 * `app-server-runtime-bindings.test.ts` fails when a bundled extension declares
 * an agent harness that has no row here, so a new bridge-backed provider cannot
 * silently ship without a chooser.
 *
 * KNOWN LIMITATION -- open maintainer decision, not an oversight. A row names a
 * canonical provider id, so this table cannot express the Copilot harness's
 * documented BYOK route: an eligible custom `models.providers` entry with a
 * non-empty `baseUrl` and a supported `api` is accepted by
 * `extensions/copilot/harness.ts` (via `supportsCopilotByokProviderShape()`,
 * see `docs/plugins/copilot.md` "Supported providers"), yet gets no chooser
 * entry here and is rejected by `--runtime copilot`. That is the behavior on
 * `main` today and this change does not alter it. Representing it means letting
 * the harness plugin declare its own provider applicability, which is a new
 * public plugin contract; the PR body records the options and the request for
 * maintainer direction. `scripts/proof-app-server-runtime-chooser-bindings.ts`
 * scenario 13 pins the current behavior so whichever contract is approved has a
 * control to flip.
 */

/** Binding between a model provider and the app-server runtime that serves it. */
export type AppServerRuntimeModelBackendBinding = {
  provider: string;
  runtime: string;
};

const APP_SERVER_RUNTIME_MODEL_BACKEND_BINDINGS: readonly AppServerRuntimeModelBackendBinding[] = [
  // Codex app-server harness (extensions/codex) running OpenAI models.
  { provider: "openai", runtime: "codex" },
  // GitHub Copilot agent runtime (extensions/copilot). `github-copilot/*` models
  // opt into it with `agentRuntime.id: "copilot"` — see copilot-routing.ts.
  { provider: "github-copilot", runtime: "copilot" },
];

/** Lists model-provider to app-server-runtime bindings for runtime choosers. */
export function listAppServerRuntimeModelBackendBindings(): readonly AppServerRuntimeModelBackendBinding[] {
  return APP_SERVER_RUNTIME_MODEL_BACKEND_BINDINGS;
}
