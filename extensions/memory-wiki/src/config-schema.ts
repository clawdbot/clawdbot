// Keep exported JSON Schema construction outside Doctor's config-resolution closure.
import { mapPluginConfigIssues } from "openclaw/plugin-sdk/extension-shared";
import { buildPluginConfigSchema } from "../api.js";
import { MemoryWikiConfigSource, resolveMemoryWikiConfig } from "./config.js";

export const memoryWikiConfigSchema = buildPluginConfigSchema(MemoryWikiConfigSource, {
  safeParse(value: unknown) {
    if (value === undefined) {
      return { success: true, data: resolveMemoryWikiConfig(undefined) };
    }
    const result = MemoryWikiConfigSource.safeParse(value);
    if (result.success) {
      return { success: true, data: resolveMemoryWikiConfig(result.data) };
    }
    return {
      success: false,
      error: {
        issues: mapPluginConfigIssues(result.error.issues),
      },
    };
  },
});
