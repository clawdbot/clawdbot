export type GoogleChatSpace = {
  name?: string;
  displayName?: string;
  type?: string;
};

export type GoogleChatUser = {
  name?: string;
  displayName?: string;
  email?: string;
  type?: string;
};

export type GoogleChatThread = {
  name?: string;
  threadKey?: string;
};

export type GoogleChatAttachmentDataRef = {
  resourceName?: string;
  attachmentUploadToken?: string;
};

export type GoogleChatAttachment = {
  name?: string;
  contentName?: string;
  contentType?: string;
  thumbnailUri?: string;
  downloadUri?: string;
  source?: string;
  attachmentDataRef?: GoogleChatAttachmentDataRef;
  driveDataRef?: Record<string, unknown>;
};

export type GoogleChatUserMention = {
  user?: GoogleChatUser;
  type?: string;
};

export type GoogleChatAnnotation = {
  type?: string;
  startIndex?: number;
  length?: number;
  userMention?: GoogleChatUserMention;
  slashCommand?: Record<string, unknown>;
  richLinkMetadata?: Record<string, unknown>;
  customEmojiMetadata?: Record<string, unknown>;
};

export type GoogleChatMessage = {
  name?: string;
  text?: string;
  argumentText?: string;
  sender?: GoogleChatUser;
  thread?: GoogleChatThread;
  attachment?: GoogleChatAttachment[];
  annotations?: GoogleChatAnnotation[];
};

export type GoogleChatEvent = {
  type?: string;
  eventType?: string;
  eventTime?: string;
  space?: GoogleChatSpace;
  user?: GoogleChatUser;
  message?: GoogleChatMessage;
};

export type GoogleChatReaction = {
  name?: string;
  user?: GoogleChatUser;
  emoji?: { unicode?: string };
};
