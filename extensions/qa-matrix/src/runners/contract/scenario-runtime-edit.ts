import { randomUUID } from "node:crypto";
import {
  assertNoSutReplyWindow,
  buildExactMarkerPrompt,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  primeMatrixQaDriverScenarioClient,
  runAssertedDriverTopLevelScenario,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export async function runInboundEditIgnoredScenario(context: MatrixQaScenarioContext) {
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const ignoredToken = `MATRIX_QA_EDIT_IGNORED_SOURCE_${randomUUID().slice(0, 8).toUpperCase()}`;
  const editedToken = `MATRIX_QA_EDIT_IGNORED_${randomUUID().slice(0, 8).toUpperCase()}`;
  const rootEventId = await client.sendTextMessage({
    body: buildExactMarkerPrompt(ignoredToken),
    roomId: context.roomId,
  });
  const editEventId = await client.sendReplacementMessage({
    body: buildMentionPrompt(context.sutUserId, editedToken),
    mentionUserIds: [context.sutUserId],
    roomId: context.roomId,
    targetEventId: rootEventId,
  });
  const { noReplyWindowMs } = await assertNoSutReplyWindow({
    actorId: "driver",
    client,
    context,
    roomId: context.roomId,
    since: startSince,
    startSince,
    unexpectedMessage: "unexpected SUT reply after Matrix edit-to-mention event",
  });
  return {
    artifacts: {
      editEventId,
      editedToken,
      expectedNoReplyWindowMs: noReplyWindowMs,
      rootEventId,
    },
    details: [
      `root event: ${rootEventId}`,
      `edit event: ${editEventId}`,
      `waited ${noReplyWindowMs}ms with no SUT reply`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runInboundEditNoDuplicateTriggerScenario(context: MatrixQaScenarioContext) {
  const first = await runAssertedDriverTopLevelScenario({
    context,
    label: "pre-edit reply",
    tokenPrefix: "MATRIX_QA_EDIT_ORIGINAL",
  });
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const editedToken = `MATRIX_QA_EDIT_DUPLICATE_${randomUUID().slice(0, 8).toUpperCase()}`;
  const editEventId = await client.sendReplacementMessage({
    body: buildMentionPrompt(context.sutUserId, editedToken),
    mentionUserIds: [context.sutUserId],
    roomId: context.roomId,
    targetEventId: first.driverEventId,
  });
  const { noReplyWindowMs } = await assertNoSutReplyWindow({
    actorId: "driver",
    client,
    context,
    roomId: context.roomId,
    since: startSince,
    startSince,
    unexpectedMessage: "unexpected duplicate SUT reply after Matrix edit",
  });
  return {
    artifacts: {
      editEventId,
      editedToken,
      expectedNoReplyWindowMs: noReplyWindowMs,
      originalDriverEventId: first.driverEventId,
      originalReply: first.reply,
      originalToken: first.token,
    },
    details: [
      `original driver event: ${first.driverEventId}`,
      ...buildMatrixReplyDetails("original reply", first.reply),
      `edit event: ${editEventId}`,
      `waited ${noReplyWindowMs}ms with no duplicate SUT reply`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
