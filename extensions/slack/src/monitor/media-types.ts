// Slack plugin module implements media types behavior.
export type SlackMediaResult = {
  path: string;
  contentType?: string;
  fileName?: string;
  placeholder: string;
};

export const MAX_SLACK_MEDIA_FILES = 8;
