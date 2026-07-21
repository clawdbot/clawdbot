export type SessionPresentation = {
  title: string;
  titleSource: string;
  subtitle?: string;
  family: string;
  agentId?: string;
  channel?: string;
  accountId?: string;
  peerKind?: string;
  isMain: boolean;
  isBackground: boolean;
};
