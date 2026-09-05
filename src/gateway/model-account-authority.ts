/** In-process account authority shared by connect and selection owners; never serialized. */
export type ModelAccountConnectAction = { owner: string; assertCurrent: () => void };

export type UserModelAccountSelection = ModelAccountConnectAction & { authProfileId: string };
