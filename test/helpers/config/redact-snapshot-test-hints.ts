// Redaction snapshot hints list config UI hints used by redaction tests.
import type { ConfigUiHints } from "../../../src/config/schema.js";

// Keep this fixture minimal so redaction tests exercise the hint-matching
// behavior they care about without paying to build the full config schema graph.
export const redactSnapshotTestHints: ConfigUiHints = {
  "agents.defaults.memorySearch.remote.apiKey": { sensitive: true },
  "agents.list[].memorySearch.remote.apiKey": { sensitive: true },
  "broadcast.apiToken[]": { sensitive: true },
  "env.GROQ_API_KEY": { sensitive: true },
  "gateway.auth.password": { sensitive: true },
  "models.providers.*.apiKey": { sensitive: true },
  "models.providers.*.baseUrl": { sensitive: true },
  "models.providers.*.request.headers.*": { sensitive: true },
  "models.providers.*.request.auth.token": { sensitive: true },
  "models.providers.*.request.proxy.url": { sensitive: true },
  "skills.entries.*.env.GEMINI_API_KEY": { sensitive: true },
};
