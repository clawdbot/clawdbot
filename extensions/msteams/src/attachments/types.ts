// Msteams type declarations define plugin contracts.
export type MSTeamsAttachmentLike = {
  id?: string | null;
  contentType?: string | null;
  contentUrl?: string | null;
  name?: string | null;
  thumbnailUrl?: string | null;
  content?: unknown;
};

export type MSTeamsAccessTokenProvider = {
  getAccessToken: (scope: string) => Promise<string>;
};

export type MSTeamsInboundMedia = {
  path?: string;
  contentType?: string;
  kind: "image" | "document";
  /** Transport resource identity used only to align fallback downloads. */
  sourceId?: string;
};

export type MSTeamsHtmlAttachmentSummary = {
  htmlAttachments: number;
  imgTags: number;
  dataImages: number;
  cidImages: number;
  srcHosts: string[];
  attachmentTags: number;
  attachmentIds: string[];
};

export type MSTeamsGraphMediaResult = {
  media: MSTeamsInboundMedia[];
  hostedCount?: number;
  attachmentCount?: number;
  hostedStatus?: number;
  attachmentStatus?: number;
  messageUrl?: string;
  tokenError?: boolean;
};
