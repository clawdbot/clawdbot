import type { MatrixQaObservedEvent } from "../../substrate/events.js";

export type MatrixQaReplyArtifact = {
  bodyPreview?: string;
  eventId: string;
  mentions?: MatrixQaObservedEvent["mentions"];
  relatesTo?: MatrixQaObservedEvent["relatesTo"];
  sender?: string;
  tokenMatched?: boolean;
};

export type MatrixQaCanaryArtifact = {
  driverEventId: string;
  reply: MatrixQaReplyArtifact;
  token: string;
};

export type MatrixQaScenarioArtifacts = {
  actorUserId?: string;
  driverEventId?: string;
  expectedNoReplyWindowMs?: number;
  reactionEmoji?: string;
  reactionEventId?: string;
  reactionTargetEventId?: string;
  reply?: MatrixQaReplyArtifact;
  recoveredDriverEventId?: string;
  recoveredReply?: MatrixQaReplyArtifact;
  roomKey?: string;
  roomId?: string;
  restartSignal?: string;
  rootEventId?: string;
  threadDriverEventId?: string;
  threadReply?: MatrixQaReplyArtifact;
  threadRootEventId?: string;
  threadToken?: string;
  token?: string;
  topLevelDriverEventId?: string;
  topLevelReply?: MatrixQaReplyArtifact;
  topLevelToken?: string;
  triggerBody?: string;
  membershipJoinEventId?: string;
  membershipLeaveEventId?: string;
  noticeBodyPreview?: string;
  noticeEventId?: string;
  previewBodyPreview?: string;
  previewEventId?: string;
  blockEventIds?: string[];
  transportInterruption?: string;
  joinedRoomId?: string;
};

export type MatrixQaScenarioExecution = {
  artifacts?: MatrixQaScenarioArtifacts;
  details: string;
};
