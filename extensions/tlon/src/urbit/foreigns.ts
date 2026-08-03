/**
 * Types for Urbit groups foreigns (group invites)
 * Based on packages/shared/src/urbit/groups.ts from homestead
 */

interface GroupPreviewV7 {
  meta: {
    title: string;
    description: string;
    image: string;
    cover: string;
  };
  "channel-count": number;
  "member-count": number;
  admissions: {
    privacy: "public" | "private" | "secret";
  };
}

interface ForeignInvite {
  flag: string; // group flag e.g. "~host/group-name"
  time: number; // timestamp
  from: string; // ship that sent invite
  token: string | null;
  note: string | null;
  preview: GroupPreviewV7;
  valid: boolean; // tracks if invite has been revoked
}

type Lookup = "preview" | "done" | "error";
type Progress = "ask" | "join" | "watch" | "done" | "error";

interface Foreign {
  invites: ForeignInvite[];
  lookup: Lookup | null;
  preview: GroupPreviewV7 | null;
  progress: Progress | null;
  token: string | null;
}

export interface Foreigns {
  [flag: string]: Foreign;
}

// DM invite structure from chat /v3 firehose
export interface DmInvite {
  ship: string;
  // Additional fields may be present
}
