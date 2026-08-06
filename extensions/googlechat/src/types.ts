// Googlechat type declarations define plugin contracts.
export type GoogleChatSpace = {
  name?: string;
  displayName?: string;
  type?: string;
  /** Current Google Chat field that replaces the deprecated `type` field. */
  spaceType?: string;
  /** True when the space is a 1:1 DM between a user and the Chat app. */
  singleUserBotDm?: boolean;
};

export type GoogleChatUser = {
  name?: string;
  displayName?: string;
  email?: string;
  type?: string;
};

type GoogleChatThread = {
  name?: string;
  threadKey?: string;
};

type GoogleChatAttachmentDataRef = {
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

type GoogleChatUserMention = {
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
  cardsV2?: GoogleChatCardV2[];
  attachment?: GoogleChatAttachment[];
  annotations?: GoogleChatAnnotation[];
};

export type GoogleChatActionParameter = {
  key?: string;
  value?: string;
};

export type GoogleChatAction = {
  actionMethodName?: string;
  parameters?: GoogleChatActionParameter[];
};

export type GoogleChatEvent = {
  type?: string;
  eventType?: string;
  eventTime?: string;
  space?: GoogleChatSpace;
  user?: GoogleChatUser;
  message?: GoogleChatMessage;
  action?: GoogleChatAction;
  common?: {
    invokedFunction?: string;
    parameters?: Record<string, string>;
  };
  commonEventObject?: {
    invokedFunction?: string;
    parameters?: Record<string, string>;
  };
};

type GoogleChatTextParagraphWidget = {
  textParagraph: {
    text: string;
  };
};

type GoogleChatButtonWidget = {
  buttonList: {
    buttons: Array<{
      text: string;
      onClick: {
        action: {
          function: string;
          parameters?: GoogleChatActionParameter[];
          loadIndicator?: "SPINNER" | "NONE";
        };
      };
    }>;
  };
};

type GoogleChatDividerWidget = { divider: Record<string, never> };

type GoogleChatWidget =
  | GoogleChatTextParagraphWidget
  | GoogleChatButtonWidget
  | GoogleChatDividerWidget;

export type GoogleChatCardV2 = {
  cardId?: string;
  card: {
    header?: {
      title?: string;
      subtitle?: string;
      imageType?: "SQUARE" | "CIRCLE";
    };
    sections?: Array<{
      header?: string;
      collapsible?: boolean;
      uncollapsibleWidgetsCount?: number;
      widgets?: GoogleChatWidget[];
    }>;
  };
};
