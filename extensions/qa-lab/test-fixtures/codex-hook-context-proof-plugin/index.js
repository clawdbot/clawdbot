const captures = {
  beforePromptBuild: [],
  beforeCompaction: [],
  afterCompaction: [],
};

function selectAuthenticatedContext(ctx) {
  return {
    accountId: ctx.accountId,
    senderId: ctx.senderId,
    chatId: ctx.chatId,
    channel: ctx.channel,
    sessionKey: ctx.sessionKey,
    channelContext: ctx.channelContext,
  };
}

function writeJson(res, body) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(body)}\n`);
}

export default {
  id: "qa-codex-hook-context-proof",
  register(api) {
    api.on("before_prompt_build", (_event, ctx) => {
      captures.beforePromptBuild.push(selectAuthenticatedContext(ctx));
    });
    api.on("before_compaction", (_event, ctx) => {
      captures.beforeCompaction.push(selectAuthenticatedContext(ctx));
    });
    api.on("after_compaction", (_event, ctx) => {
      captures.afterCompaction.push(selectAuthenticatedContext(ctx));
    });
    api.registerHttpRoute({
      path: "/qa/codex-hook-context-proof",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      async handler(_req, res) {
        writeJson(res, captures);
        return true;
      },
    });
  },
};
