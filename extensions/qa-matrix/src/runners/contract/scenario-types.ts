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
  accepted?: MatrixQaScenarioArtifacts;
  attachments?: Array<{
    eventId: string;
    filename?: string;
    kind?: string;
    label: string;
    msgtype?: string;
  }>;
  attachmentCaptionPreview?: string;
  attachmentBodyPreview?: string;
  attachmentEventId?: string;
  attachmentFilename?: string;
  attachmentKind?: string;
  attachmentMsgtype?: string;
  actorUserId?: string;
  blocked?: MatrixQaScenarioArtifacts;
  driverEventId?: string;
  editEventId?: string;
  editedToken?: string;
  expectedNoReplyWindowMs?: number;
  firstDriverEventId?: string;
  firstReply?: MatrixQaReplyArtifact;
  firstToken?: string;
  originalDriverEventId?: string;
  originalReply?: MatrixQaReplyArtifact;
  originalToken?: string;
  reactionEmoji?: string;
  reactionEventId?: string;
  reactionTargetEventId?: string;
  redactionEventId?: string;
  reply?: MatrixQaReplyArtifact;
  replies?: Array<{
    eventId: string;
    label: string;
    token: string;
    tokenMatched?: boolean;
  }>;
  recoveredDriverEventId?: string;
  recoveredReply?: MatrixQaReplyArtifact;
  rootEventId?: string;
  roomKey?: string;
  roomId?: string;
  restartSignal?: string;
  secondDriverEventId?: string;
  secondReply?: MatrixQaReplyArtifact;
  secondToken?: string;
  subagentCompletion?: MatrixQaReplyArtifact;
  subagentIntro?: MatrixQaReplyArtifact;
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
  bootstrapActor?: "driver" | "observer" | "sut";
  bootstrapErrorPreview?: string;
  bootstrapSuccess?: boolean;
  backupCreatedVersion?: string | null;
  backupRestored?: boolean;
  backupReset?: boolean;
  completedVerificationIds?: string[];
  currentDeviceId?: string | null;
  deletedDeviceIds?: string[];
  faultedEndpoint?: string;
  faultHitCount?: number;
  faultRuleId?: string;
  qrBytes?: number;
  recoveryKeyId?: string | null;
  recoveryKeyStored?: boolean;
  remainingDeviceIds?: string[];
  sasEmoji?: string[];
  secondaryDeviceId?: string;
  transportInterruption?: string;
  verificationRoomId?: string;
  joinedRoomId?: string;
};

export type MatrixQaScenarioExecution = {
  artifacts?: MatrixQaScenarioArtifacts;
  details: string;
};
