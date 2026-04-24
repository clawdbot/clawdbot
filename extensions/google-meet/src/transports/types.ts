import type { GoogleMeetMode, GoogleMeetTransport } from "../config.js";

export type GoogleMeetSessionState = "active" | "ended";

export type GoogleMeetJoinRequest = {
  url: string;
  transport?: GoogleMeetTransport;
  mode?: GoogleMeetMode;
  dialInNumber?: string;
  pin?: string;
  dtmfSequence?: string;
};

export type GoogleMeetSession = {
  id: string;
  url: string;
  transport: GoogleMeetTransport;
  mode: GoogleMeetMode;
  state: GoogleMeetSessionState;
  createdAt: string;
  updatedAt: string;
  participantIdentity: string;
  realtime: {
    enabled: boolean;
    provider?: string;
    model?: string;
    toolPolicy: string;
  };
  chrome?: {
    audioBackend: "blackhole-2ch";
    launched: boolean;
    nodeId?: string;
    browserProfile?: string;
    audioBridge?: {
      type: "command-pair" | "node-command-pair" | "external-command";
      provider?: string;
    };
  };
  twilio?: {
    dialInNumber: string;
    pinProvided: boolean;
    dtmfSequence?: string;
    voiceCallId?: string;
    dtmfSent?: boolean;
  };
  notes: string[];
};

export type GoogleMeetJoinResult = {
  session: GoogleMeetSession;
};
