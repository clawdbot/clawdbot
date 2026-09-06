import * as progressCard from "./progress-card.js";

export const ProgressCardProtocolSchemas = {
  ProgressCardStepStatus: progressCard.ProgressCardStepStatusSchema,
  ProgressCardStep: progressCard.ProgressCardStepSchema,
  ProgressCard: progressCard.ProgressCardSchema,
  ProgressCardGetParams: progressCard.ProgressCardGetParamsSchema,
  ProgressCardGetResult: progressCard.ProgressCardGetResultSchema,
  ProgressCardPutParams: progressCard.ProgressCardPutParamsSchema,
  ProgressCardPutResult: progressCard.ProgressCardPutResultSchema,
  ProgressCardChangedEvent: progressCard.ProgressCardChangedEventSchema,
};
