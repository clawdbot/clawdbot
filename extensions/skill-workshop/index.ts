import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry, resolveDefaultAgentId } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { buildWorkshopGuidance } from "./src/prompt.js";
import { countToolCalls, reviewTranscriptForProposal } from "./src/reviewer.js";
import { createProposalFromMessages } from "./src/signals.js";
import { createSkillWorkshopTool } from "./src/tool.js";
import { applyOrStoreProposal, createStoreForContext } from "./src/workshop.js";

export default definePluginEntry({
  id: "skill-workshop",
  name: "Skill Workshop",
  description:
    "Captures repeatable workflows as workspace skills, with pending review and safe writes.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-workshop",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      (ctx) => {
        const config = resolveCurrentConfig();
        if (!config.enabled) {
          return null;
        }
        return createSkillWorkshopTool({ api, config, ctx });
      },
      {
        name: "skill_workshop",
      },
    );

    api.on("before_prompt_build", async () => {
      const config = resolveCurrentConfig();
      if (!config.enabled) {
        return undefined;
      }
      return {
        prependSystemContext: buildWorkshopGuidance(config),
      };
    });

    api.on("agent_end", async (event, ctx) => {
      const config = resolveCurrentConfig();
      if (!config.enabled || !config.autoCapture || config.reviewMode === "off") {
        return;
      }
      if (!event.success) {
        return;
      }
      if (ctx.sessionId?.startsWith("skill-workshop-review-")) {
        return;
      }
      const agentId = ctx.agentId ?? resolveDefaultAgentId(api.config);
      const workspaceDir =
        ctx.workspaceDir || api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
      const store = createStoreForContext({ api, ctx: { ...ctx, workspaceDir }, config });
      const heuristicProposal = createProposalFromMessages({
        messages: event.messages,
        workspaceDir,
        agentId,
        sessionId: ctx.sessionId,
      });
      const heuristicEnabled = config.reviewMode === "heuristic" || config.reviewMode === "hybrid";
      if (heuristicEnabled && heuristicProposal) {
        try {
          const result = await applyOrStoreProposal({
            proposal: heuristicProposal,
            store,
            config,
            workspaceDir,
          });
          if (result.status === "applied") {
            api.logger.info(`skill-workshop: applied ${heuristicProposal.skillName}`);
          } else if (result.status === "quarantined") {
            api.logger.warn(`skill-workshop: quarantined ${heuristicProposal.skillName}`);
          } else {
            api.logger.info(`skill-workshop: queued ${heuristicProposal.skillName}`);
          }
        } catch (error) {
          api.logger.warn(`skill-workshop: heuristic capture skipped: ${String(error)}`);
        }
      }

      const llmEnabled = config.reviewMode === "llm" || config.reviewMode === "hybrid";
      if (!llmEnabled) {
        return;
      }
      const reviewState = await store.recordReviewTurn(countToolCalls(event.messages));
      const thresholdMet =
        reviewState.turnsSinceReview >= config.reviewInterval ||
        reviewState.toolCallsSinceReview >= config.reviewMinToolCalls;
      const shouldReview =
        thresholdMet || (config.reviewMode === "llm" && heuristicProposal !== undefined);
      if (!shouldReview) {
        return;
      }
      await store.markReviewed();
      try {
        const proposal = await reviewTranscriptForProposal({
          api,
          config,
          messages: event.messages,
          ctx: {
            agentId,
            sessionId: ctx.sessionId,
            sessionKey: ctx.sessionKey,
            workspaceDir,
            modelProviderId: ctx.modelProviderId,
            modelId: ctx.modelId,
            messageProvider: ctx.messageProvider,
            channelId: ctx.channelId,
          },
        });
        if (!proposal) {
          api.logger.debug?.("skill-workshop: reviewer found no update");
          return;
        }
        const result = await applyOrStoreProposal({ proposal, store, config, workspaceDir });
        if (result.status === "applied") {
          api.logger.info(`skill-workshop: applied ${proposal.skillName}`);
        } else if (result.status === "quarantined") {
          api.logger.warn(`skill-workshop: quarantined ${proposal.skillName}`);
        } else {
          api.logger.info(`skill-workshop: queued ${proposal.skillName}`);
        }
      } catch (error) {
        api.logger.warn(`skill-workshop: reviewer skipped: ${String(error)}`);
      }
    });
  },
});

export { createProposalFromMessages } from "./src/signals.js";
export { SkillWorkshopStore } from "./src/store.js";
export { applyProposalToWorkspace } from "./src/skills.js";
export { reviewTranscriptForProposal } from "./src/reviewer.js";
export { scanSkillContent } from "./src/scanner.js";
