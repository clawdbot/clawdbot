import { note } from "../terminal/note.js";
import type { MoltbotConfig } from "../config/config.js";

const OLLAMA_API_BASE_URL = "http://127.0.0.1:11434";

export async function noteOllamaHealth(cfg: MoltbotConfig): Promise<void> {
  const isStrictLocal = cfg.security?.strictLocal === true;
  const hasOllamaProvider = cfg.models?.providers?.ollama !== undefined;

  // Only check Ollama if it's explicitly configured, or if we are in strict local mode.
  if (!hasOllamaProvider && !isStrictLocal) return;

  try {
    const response = await fetch(`${OLLAMA_API_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) {
      note(`Ollama at ${OLLAMA_API_BASE_URL} responded with status ${response.status}.`, "Ollama");
      return;
    }

    const data = (await response.json()) as { models?: Array<{ name: string }> };
    const models = data.models ?? [];

    if (models.length === 0) {
      note(`Ollama is running but no models are downloaded. Run \`ollama pull llama3\` (or another model).`, "Ollama");
    } else {
      const modelNames = models.map((m) => m.name).slice(0, 5);
      const more = models.length > 5 ? ` (and ${models.length - 5} more)` : "";
      note(`Ollama is running with ${models.length} model(s): ${modelNames.join(", ")}${more}.`, "Ollama");
    }
  } catch (err) {
    if (isStrictLocal || hasOllamaProvider) {
      note(`Ollama connection failed at ${OLLAMA_API_BASE_URL}: ${String(err)}. Is Ollama running?`, "Ollama");
    }
  }
}
