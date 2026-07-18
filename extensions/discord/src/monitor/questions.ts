// Discord ask_user component dispatch and ephemeral feedback.
import { ButtonStyle } from "discord-api-types/v10";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { Button, type ButtonInteraction, type ComponentData } from "../internal/discord.js";
import { parseDiscordQuestionData } from "../question-custom-id.js";
import {
  type AgentComponentContext,
  resolveAuthorizedComponentInteraction,
} from "./agent-components-helpers.js";

type ResolveQuestionParams = Parameters<typeof questionGatewayRuntime.resolveOption>[0];
type QuestionResolver = (
  params: ResolveQuestionParams,
) => ReturnType<typeof questionGatewayRuntime.resolveOption>;

class QuestionButton extends Button {
  override label = "question";
  customId = "ocq:id=seed;i=0";
  override style = ButtonStyle.Primary;

  constructor(
    private readonly ctx: {
      cfg: ResolveQuestionParams["cfg"];
      accountId: string;
      resolveQuestion: QuestionResolver;
      authorizeQuestion: (interaction: ButtonInteraction) => Promise<boolean>;
    },
  ) {
    super();
  }

  override async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    const callback = parseDiscordQuestionData(data);
    if (!callback) {
      await interaction.reply({ content: "This question is no longer valid.", ephemeral: true });
      return;
    }
    if (!(await this.ctx.authorizeQuestion(interaction))) {
      return;
    }
    try {
      await interaction.acknowledge();
    } catch {}
    let result: Awaited<ReturnType<QuestionResolver>>;
    try {
      result = await this.ctx.resolveQuestion({
        cfg: this.ctx.cfg,
        questionId: callback.questionId,
        optionIndex: callback.optionIndex,
        senderId: interaction.userId,
        clientDisplayName: `Discord question (${this.ctx.accountId})`,
      });
    } catch {
      try {
        await interaction.followUp({ content: "Could not submit this answer.", ephemeral: true });
      } catch {}
      return;
    }
    try {
      await interaction.followUp({
        content:
          result.status === "answered"
            ? "Answer submitted."
            : "This question was already answered.",
        ephemeral: true,
      });
    } catch {
      // Gateway state already committed; receipt delivery is best-effort.
    }
  }
}

export function createDiscordQuestionButton(params: {
  cfg: ResolveQuestionParams["cfg"];
  accountId: string;
  authContext?: AgentComponentContext;
  authorizeQuestion?: (interaction: ButtonInteraction) => Promise<boolean>;
  resolveQuestion?: QuestionResolver;
}): Button {
  const authContext = params.authContext ?? { cfg: params.cfg, accountId: params.accountId };
  return new QuestionButton({
    cfg: params.cfg,
    accountId: params.accountId,
    resolveQuestion: params.resolveQuestion ?? questionGatewayRuntime.resolveOption,
    authorizeQuestion:
      params.authorizeQuestion ??
      (async (interaction) =>
        Boolean(
          await resolveAuthorizedComponentInteraction({
            ctx: authContext,
            interaction,
            label: "discord question",
            componentLabel: "button",
            unauthorizedReply: "You are not authorized to answer this question.",
            defer: false,
          }),
        )),
  });
}
