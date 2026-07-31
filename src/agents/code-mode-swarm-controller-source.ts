/** Guest-side Swarm helpers injected into the isolated QuickJS controller. */
export const CODE_MODE_SWARM_CONTROLLER_SOURCE = String.raw`
  class SwarmAgentError extends Error {
    constructor(runId, status, detail) {
      super("Swarm agent " + runId + " " + status + ": " + detail);
      this.name = "SwarmAgentError";
      this.runId = runId;
      this.status = status;
    }
  }

  function swarmNote(kind, value) {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError(kind + " note must be a non-empty string");
    }
    void request("swarmNote", [{ kind, text: value }]).catch(() => {});
  }

  async function runAgent(prompt, options = {}) {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new TypeError("agents.run prompt must be a non-empty string");
    }
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("agents.run options must be an object");
    }
    if (options.phase !== undefined && (typeof options.phase !== "string" || !options.phase.trim())) {
      throw new TypeError("agents.run phase must be a non-empty string");
    }
    if (options.phase !== undefined) swarmNote("phase", options.phase);
    const spawned = await request("agentSpawn", [prompt, options]);
    const completion = await request("agentWait", [spawned.runId]);
    if (!completion || completion.status !== "done") {
      const runId = completion?.runId ?? spawned.runId ?? "unknown";
      const status = completion?.status ?? "failed";
      const detail = completion?.schemaError || completion?.result || "collector returned no result";
      throw new SwarmAgentError(runId, status, detail);
    }
    return options.schema !== undefined ? completion.structured : completion.result;
  }
`;
