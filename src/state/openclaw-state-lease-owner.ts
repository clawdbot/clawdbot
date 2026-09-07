export type LeaseExclusionParams = {
  databasePath: () => string;
  assertActive: () => void;
  readExpiry: (databasePath: string) => number;
  readPublicationExpiry: (databasePath: string) => number;
  readMutationExpiry: (databasePath: string) => number;
  pause: () => Promise<void>;
  resume: (expiresAt: number) => Promise<void>;
  onLost: (error: Error) => void;
};
export type CaptureOwner = {
  params: LeaseExclusionParams;
  databasePath?: string;
  busy: boolean;
  cleanupAllowed: boolean;
  admissionClosed: boolean;
  assertion?: () => void;
  mutationAssertion?: () => void;
  admitted: Promise<unknown>[];
};
