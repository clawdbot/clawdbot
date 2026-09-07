import { TSDOWN_NON_SDK_DTS_CONFIG_GROUPS } from "./lib/tsdown-config-groups.mts";
import { writeTsdownDeclarations } from "./lib/tsdown-declaration-writer.mts";
import { listReplaceableTsdownDeclarationOutputs } from "./tsdown-build.mts";

await writeTsdownDeclarations(
  TSDOWN_NON_SDK_DTS_CONFIG_GROUPS,
  "tsdown-unified",
  (root) => listReplaceableTsdownDeclarationOutputs({ cwd: root, roots: ["dist"] }),
  "scripts/write-unified-entry-dts.ts",
);
