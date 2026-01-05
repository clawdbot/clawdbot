export type MsgContext = {
  Body?: string;
  From?: string;
  To?: string;
  SessionKey?: string;
  MessageSid?: string;
  ReplyToId?: string;
  ReplyToBody?: string;
  ReplyToSender?: string;
  MediaPath?: string;
  MediaUrl?: string;
  MediaType?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
  Transcript?: string;
  ChatType?: string;
  GroupSubject?: string;
  GroupRoom?: string;
  GroupSpace?: string;
  GroupMembers?: string;
  SenderName?: string;
  SenderId?: string;
  SenderUsername?: string;
  SenderTag?: string;
  SenderE164?: string;
  Surface?: string;
  WasMentioned?: boolean;
  CommandAuthorized?: boolean;
};

export type TemplateContext = MsgContext & {
  BodyStripped?: string;
  SessionId?: string;
  IsNewSession?: string;
};

// Simple {{Placeholder}} interpolation using inbound message context.
export function applyTemplate(str: string | undefined, ctx: TemplateContext) {
  if (!str) return "";
  return str.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const value = ctx[key as keyof TemplateContext];
    return value == null ? "" : String(value);
  });
}
