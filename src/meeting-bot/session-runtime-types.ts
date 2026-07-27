import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingSessionRecord,
} from "./session-types.js";

export type MeetingSessionRuntimeHandles<THealth extends MeetingBrowserHealth> = {
  stop?: () => Promise<void>;
  speak?: (instructions?: string) => void;
  getHealth?: () => Partial<THealth>;
};

export type MeetingBrowserSessionView<
  THealth extends MeetingBrowserHealth,
  TTab extends MeetingBrowserTab,
> = {
  launched: boolean;
  nodeId?: string;
  tab?: TTab;
  health?: THealth;
  hasAudioBridge: boolean;
};

export type MeetingSessionRuntimeJoinContext<
  TSession extends MeetingSessionRecord<TTransport, TMode>,
  TTransport extends string,
  TMode extends string,
  THealth extends MeetingBrowserHealth,
  TTab extends MeetingBrowserTab,
> = {
  attachRuntimeHandles(session: TSession, handles: MeetingSessionRuntimeHandles<THealth>): void;
  inheritedBrowserTab(params: {
    session: TSession;
    transport: TTransport;
    nodeId?: string;
    meetingUrl: string;
    tab?: TTab;
  }): TTab | undefined;
};
