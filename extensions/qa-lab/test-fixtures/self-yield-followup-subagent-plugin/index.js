import { randomUUID } from "node:crypto";

const TRIGGER = "qa self yield follow-up";
const FOLLOW_UP_MESSAGE =
  "Subagent self yield qa remote job finished. Reply with only the exact marker.";
const stateKey = Symbol.for("openclaw.qaSelfYieldFollowupState");

function getState() {
  if (globalThis[stateKey]) {
    return globalThis[stateKey];
  }
  let resolveFinalReply;
  const finalReply = new Promise((resolve) => {
    resolveFinalReply = resolve;
  });
  return (globalThis[stateKey] = {
    childSessionKey: undefined,
    finalReply,
    followUpRunId: undefined,
    kickoffRunId: undefined,
    resolveFinalReply,
    yieldEntered: false,
    releaseYield: undefined,
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(body)}\n`);
}

export default {
  id: "qa-self-yield-followup-subagent",
  register(api) {
    api.on("before_tool_call", async (event) => {
      if (event.toolName !== "sessions_yield") {
        return;
      }
      const state = getState();
      state.yieldEntered = true;
      await new Promise((resolve) => {
        state.releaseYield = resolve;
      });
    });

    api.on("before_dispatch", async (event) => {
      if (!event.content.toLowerCase().includes(TRIGGER)) {
        return undefined;
      }
      // The kickoff reports its session key so the follow-up can target the same
      // paused session. Adoption is keyed on that session; a fresh key would
      // register an unrelated run instead of continuing this one.
      const childSessionKey = `agent:qa:subagent:qa-self-yield-${randomUUID()}`;
      getState().childSessionKey = childSessionKey;
      let result;
      try {
        result = await api.runtime.subagent.run({
          sessionKey: childSessionKey,
          message: "Subagent self yield qa worker: pause until the remote job reports back.",
          deliver: false,
          // Binds the requester to the operator turn that triggered this hook, so
          // the announce this scenario waits for has a real audience to reach.
          completionDelivery: "current-requester",
        });
        getState().kickoffRunId = result.runId;
        const finalReply = await getState().finalReply;
        return { handled: true, text: finalReply };
      } catch (error) {
        return {
          handled: true,
          text: `QA-SELF-YIELD-ERROR ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });

    api.registerHttpRoute({
      path: "/qa/self-yield/follow-up",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      async handler(req, res) {
        await readJsonBody(req);
        const state = getState();
        const stateDeadline = Date.now() + 15_000;
        while (!state.childSessionKey && Date.now() < stateDeadline) {
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
        }
        const childSessionKey = state.childSessionKey;
        if (!childSessionKey) {
          writeJson(res, 409, { ok: false, error: "no kickoff session" });
          return true;
        }
        try {
          // Default delivery on purpose: a follow-up that named its own requester
          // would opt into its own audience and run as a sibling, which is the
          // path this proof must not take.
          const deadline = Date.now() + 15_000;
          while (!state.yieldEntered && Date.now() < deadline) {
            await new Promise((resolve) => {
              setTimeout(resolve, 10);
            });
          }
          if (!state.yieldEntered) {
            throw new Error("sessions_yield did not reach the handoff gate");
          }
          const result = await api.runtime.subagent.run({
            sessionKey: childSessionKey,
            message: FOLLOW_UP_MESSAGE,
            deliver: false,
          });
          state.followUpRunId = result.runId;
          writeJson(res, 202, {
            ok: true,
            kickoffRunId: state.kickoffRunId,
            runId: result.runId,
          });
        } catch (error) {
          writeJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return true;
      },
    });

    api.registerHttpRoute({
      path: "/qa/self-yield/release",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      async handler(_req, res) {
        const state = getState();
        if (!state.followUpRunId || !state.releaseYield) {
          writeJson(res, 409, { ok: false, error: "follow-up was not queued" });
          return true;
        }
        state.releaseYield();
        state.releaseYield = undefined;
        const terminal = await api.runtime.subagent.waitForRun({
          runId: state.followUpRunId,
          timeoutMs: 90_000,
        });
        const messages = await api.runtime.subagent.getSessionMessages({
          sessionKey: state.childSessionKey,
          limit: 20,
        });
        const finalReply = messages.messages
          .filter((message) => message?.role === "assistant")
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .flatMap((part) =>
            part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
          )
          .at(-1);
        if (terminal.status === "ok" && finalReply) {
          state.resolveFinalReply(finalReply);
        }
        writeJson(res, 200, {
          ok: terminal.status === "ok",
          kickoffRunId: state.kickoffRunId,
          runId: state.followUpRunId,
          status: terminal.status,
          finalReply,
        });
        return true;
      },
    });
  },
};
