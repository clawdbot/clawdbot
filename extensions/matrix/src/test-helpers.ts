import fs from "node:fs";
import path from "node:path";

export const MATRIX_TEST_HOMESERVER = "https://matrix.example.org";
export const MATRIX_DEFAULT_USER_ID = "@bot:example.org";
export const MATRIX_DEFAULT_ACCESS_TOKEN = "tok-123";
export const MATRIX_DEFAULT_DEVICE_ID = "DEVICE123";
export const MATRIX_OPS_ACCOUNT_ID = "ops";
export const MATRIX_OPS_USER_ID = "@ops-bot:example.org";
export const MATRIX_OPS_ACCESS_TOKEN = "tok-ops";
export const MATRIX_OPS_DEVICE_ID = "DEVICEOPS";

export function writeFile(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

export function writeMatrixCredentials(
  stateDir: string,
  params?: {
    accountId?: string;
    homeserver?: string;
    userId?: string;
    accessToken?: string;
    deviceId?: string;
  },
) {
  const accountId = params?.accountId ?? MATRIX_OPS_ACCOUNT_ID;
  writeFile(
    path.join(stateDir, "credentials", "matrix", `credentials-${accountId}.json`),
    JSON.stringify(
      {
        homeserver: params?.homeserver ?? MATRIX_TEST_HOMESERVER,
        userId: params?.userId ?? MATRIX_OPS_USER_ID,
        accessToken: params?.accessToken ?? MATRIX_OPS_ACCESS_TOKEN,
        deviceId: params?.deviceId ?? MATRIX_OPS_DEVICE_ID,
      },
      null,
      2,
    ),
  );
}
