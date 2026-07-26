declare const accountId: string;
declare const filePath: string;
declare const secretRef: string;
declare const tryReadSecretFileSync: (...args: unknown[]) => string;
declare const normalizeResolvedSecretInputString: (options: unknown) => string;

export const passwordFile = tryReadSecretFileSync(filePath, "IRC password file", {
  credentialDiagnostic: {
    configPath: `channels.irc.accounts.${accountId}.passwordFile`,
  },
});
export const nickservFile = tryReadSecretFileSync(filePath, "IRC NickServ password file", {
  credentialDiagnostic: {
    configPath: `channels.irc.accounts.${accountId}.nickserv.passwordFile`,
  },
});
export const botSecret = normalizeResolvedSecretInputString({
  value: secretRef,
  path: `channels.nextcloud-talk.accounts.${accountId}.botSecret`,
});
export const botSecretFile = tryReadSecretFileSync(filePath, "Nextcloud bot secret file", {
  credentialDiagnostic: {
    configPath: `channels.nextcloud-talk.accounts.${accountId}.botSecretFile`,
  },
});
export const tokenFile = tryReadSecretFileSync(
  filePath,
  `channels.telegram.accounts.${accountId}.tokenFile`,
  { rejectSymlink: true },
);
