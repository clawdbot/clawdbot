export type ZoomMeetingStatusPreludeParams = {
  allowMicrophone: boolean;
  allowSessionAdoption: boolean;
  autoJoin: boolean;
  captureCaptions: boolean;
  expectedIdentity?: string;
  guestName: string;
  meetingSessionId?: string;
  pageIdentitySource: string;
  readOnly?: boolean;
  selectors: string;
  toggleStateFunction: string;
  waitForInCallMs: number;
};
