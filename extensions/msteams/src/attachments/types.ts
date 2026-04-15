export type MSTeamsAttachmentLike = {
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
  path: string;
  contentType?: string;
  placeholder: string;
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

/**
 * Narrow logger surface used by `downloadMSTeamsGraphMedia` for diagnostic
 * events. Accepting an optional callback keeps the helper testable without
 * pulling in the full channel logger type, while still allowing the monitor
 * handler to forward its plugin logger.
 */
export type MSTeamsGraphMediaLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
};
