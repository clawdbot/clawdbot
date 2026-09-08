// Keeps shared and standalone live images aligned with the release provider roster.
import path from "node:path";
import { resolveDockerPluginSelection } from "./lib/docker-plugin-selection.mjs";
import { createReleaseWorkflowMatrixPlan } from "./plan-release-workflow-matrix.mjs";

// Standalone shards reuse one image, so a focused invocation must retain the full roster.
const plan = createReleaseWorkflowMatrixPlan({ releaseProfile: "full", includeLiveSuites: true });
const providers = [
  "deepseek", // Gateway fixture provider outside the direct-model roster.
  ...plan.liveModels.matrix.include.map((entry) => entry.providers),
  process.env.OPENCLAW_LIVE_PROVIDERS ?? "",
  process.env.OPENCLAW_LIVE_GATEWAY_PROVIDERS ?? "",
  process.env.OPENCLAW_LIVE_MODELS ?? "",
  process.env.OPENCLAW_LIVE_GATEWAY_MODELS ?? "",
].flatMap((value) => value.split(/[\s,]+/u).map((ref) => ref.split("/")[0]));

// Gateway/CLI fixtures also require these plugin artifacts.
const selection = `matrix,acpx,anthropic,${process.argv[3] ?? ""}`;
const selected = resolveDockerPluginSelection({
  extensionsRoot: path.join(process.argv[2] ?? process.cwd(), "extensions"),
  selection,
  providers,
});
console.log(selected.join(","));
