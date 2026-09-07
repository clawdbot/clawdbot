import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
let createDirectory: ((directoryPath: string) => void) | undefined;

function loadPrivateDirectoryCreator(): (directoryPath: string) => void {
  const koffi: typeof import("koffi").default = require("koffi");
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");
  const attributes = koffi.struct({
    length: "uint32_t",
    descriptor: "void *",
    inheritHandle: "int32_t",
  });
  const getLastError = kernel32.func("uint32_t __stdcall GetLastError()");
  const getCurrentProcess = kernel32.func("void * __stdcall GetCurrentProcess()");
  const closeHandle = kernel32.func("int32_t __stdcall CloseHandle(void *handle)");
  const localFree = kernel32.func("void * __stdcall LocalFree(void *memory)");
  const openToken = advapi32.func(
    "int32_t __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
  );
  const getTokenInformation = advapi32.func(
    "int32_t __stdcall GetTokenInformation(void *token, int32_t informationClass, _Out_ void *information, uint32_t length, _Out_ uint32_t *required)",
  );
  const convertSid = advapi32.func(
    "int32_t __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)",
  );
  const convertDescriptor = advapi32.func(
    "int32_t __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t revision, _Out_ void **descriptor, void *size)",
  );
  const create = kernel32.func("__stdcall", "CreateDirectoryW", "int32_t", [
    "str16",
    koffi.pointer(attributes),
  ]);
  const failure = (operation: string) => {
    const errorCode: number = getLastError();
    return Object.assign(new Error(`${operation} failed (Win32 error ${errorCode})`), {
      code: errorCode === 80 || errorCode === 183 ? "EEXIST" : "EIO",
      errno: errorCode,
    });
  };

  return (directoryPath) => {
    const token: [bigint | null] = [null];
    const sidText: [bigint | null] = [null];
    const descriptor: [bigint | null] = [null];
    // Read the primary token on each call; directory ownership belongs to the
    // creating process, not to a username or an environment-provided SID.
    if (!openToken(getCurrentProcess(), 0x0008, token)) {
      throw failure("OpenProcessToken");
    }
    try {
      const required: [number] = [0];
      getTokenInformation(token[0], 1, null, 0, required);
      if (getLastError() !== 122 || required[0] === 0) {
        throw failure("GetTokenInformation(size)");
      }
      const user = Buffer.alloc(required[0]);
      if (!getTokenInformation(token[0], 1, user, user.length, required)) {
        throw failure("GetTokenInformation");
      }
      // TOKEN_USER begins with SID_AND_ATTRIBUTES, whose first field is PSID.
      if (!convertSid(koffi.decode(user, "void *"), sidText)) {
        throw failure("ConvertSidToStringSidW");
      }
      const sid: string = koffi.decode(sidText[0], "char16_t", -1);
      const sddl = `O:${sid}D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
      if (!convertDescriptor(sddl, 1, descriptor, null)) {
        throw failure("ConvertStringSecurityDescriptorToSecurityDescriptorW");
      }
      // Apply the protected, inheritable DACL during exclusive creation. A
      // create-then-ACL sequence exposes a race and accepts attacker-owned paths.
      if (
        !create(path.toNamespacedPath(path.resolve(directoryPath)), {
          length: koffi.sizeof(attributes),
          descriptor: descriptor[0],
          inheritHandle: 0,
        })
      ) {
        throw failure(`CreateDirectoryW(${directoryPath})`);
      }
    } finally {
      if (descriptor[0] !== null) {
        localFree(descriptor[0]);
      }
      if (sidText[0] !== null) {
        localFree(sidText[0]);
      }
      closeHandle(token[0]);
    }
  };
}

export function createPrivateWindowsDirectory(directoryPath: string): void {
  createDirectory ??= loadPrivateDirectoryCreator();
  createDirectory(directoryPath);
}
