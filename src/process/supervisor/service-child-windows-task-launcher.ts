import path from "node:path";
import {
  bindWindowsProcessJobToOwner,
  createWindowsJobBindings,
} from "./service-child-windows-job-native.js";

type NativeHandle = bigint;
const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_DUP_HANDLE = 0x0040;
const SYNCHRONIZE = 0x0010_0000;
const WAIT_TIMEOUT = 258;

/** Bind a generated WScript -> CMD -> supervisor launch to its actual, still-live WScript owner. */
export function bindWindowsTaskLauncher(koffi: typeof import("koffi").default): void {
  const bindings = createWindowsJobBindings(koffi);
  bindings.assertLayouts();
  const kernel32 = koffi.load("kernel32.dll");
  const ntdll = koffi.load("ntdll.dll");
  const outDword = koffi.out(koffi.pointer("uint32_t"));
  const inoutDword = koffi.inout(koffi.pointer("uint32_t"));
  const OpenProcess = kernel32.func("__stdcall", "OpenProcess", "void *", [
    "uint32_t",
    "int32_t",
    "uint32_t",
  ]);
  const GetProcessTimes = kernel32.func("__stdcall", "GetProcessTimes", "int32_t", [
    "void *",
    "void *",
    "void *",
    "void *",
    "void *",
  ]);
  const QueryImage = kernel32.func("__stdcall", "QueryFullProcessImageNameW", "int32_t", [
    "void *",
    "uint32_t",
    "void *",
    inoutDword,
  ]);
  const QueryBasic = ntdll.func("__stdcall", "NtQueryInformationProcess", "int32_t", [
    "void *",
    "uint32_t",
    "void *",
    "uint32_t",
    outDword,
  ]);
  const requireLive = (handle: NativeHandle, role: string) => {
    if (bindings.WaitForSingleObject(handle, 0) !== WAIT_TIMEOUT) {
      throw new Error(`Windows task ${role} is no longer live`);
    }
  };
  const identity = (handle: NativeHandle, expectedPid: number, role: string) => {
    // Win64 PROCESS_BASIC_INFORMATION: PID and inherited parent PID follow four pointer-sized slots.
    const basic = Buffer.alloc(48);
    const returned = [0];
    const result = QueryBasic(handle, 0, basic, basic.length, returned);
    if (result < 0) {
      throw new Error(`NtQueryInformationProcess(${role}) failed (NTSTATUS ${result})`);
    }
    if (returned[0] !== basic.length || basic.readBigUInt64LE(32) !== BigInt(expectedPid)) {
      throw new Error(`Windows task ${role} process identity changed`);
    }
    const parentPid = Number(basic.readBigUInt64LE(40));
    if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || parentPid > 0xffff_ffff) {
      throw new Error(`Windows task ${role} has an invalid parent process`);
    }
    const imageBuffer = Buffer.alloc(32768 * 2);
    const imageChars: [number] = [32768];
    if (!QueryImage(handle, 0, imageBuffer, imageChars)) {
      throw bindings.lastError(`QueryFullProcessImageNameW(${role})`);
    }
    if (imageChars[0] < 1 || imageChars[0] > 32768) {
      throw new Error(`Windows task ${role} has an invalid image path`);
    }
    const creationTime = Buffer.alloc(8);
    if (!GetProcessTimes(handle, creationTime, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) {
      throw bindings.lastError(`GetProcessTimes(${role})`);
    }
    const created = creationTime.readBigUInt64LE();
    if (created === 0n) {
      throw new Error(`Windows task ${role} has no process creation time`);
    }
    return {
      parentPid,
      image: path.win32
        .basename(imageBuffer.toString("utf16le", 0, imageChars[0] * 2))
        .toLowerCase(),
      created,
    };
  };

  const supervisor = identity(bindings.GetCurrentProcess(), process.pid, "supervisor");
  const parentAccess = PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
  let cmd: NativeHandle | undefined;
  let launcher: NativeHandle | undefined;
  try {
    cmd = bindings.requireHandle(
      OpenProcess(parentAccess, 0, supervisor.parentPid),
      "OpenProcess(CMD)",
    );
    const command = identity(cmd, supervisor.parentPid, "CMD");
    if (command.image !== "cmd.exe" || command.created > supervisor.created) {
      throw new Error("Windows task supervisor lost its original CMD launcher");
    }
    launcher = bindings.requireHandle(
      OpenProcess(parentAccess | PROCESS_DUP_HANDLE, 0, command.parentPid),
      "OpenProcess(WScript)",
    );
    const host = identity(launcher, command.parentPid, "WScript");
    if (host.image !== "wscript.exe" || host.created > command.created) {
      throw new Error("Windows task supervisor lost its original WScript launcher");
    }
    // Handles pin kernel identities; creation ordering rejects recycled parent PIDs.
    requireLive(cmd, "CMD launcher");
    requireLive(launcher, "WScript launcher");
    bindWindowsProcessJobToOwner(bindings, launcher);
  } finally {
    if (launcher !== undefined) {
      bindings.CloseHandle(launcher);
    }
    if (cmd !== undefined) {
      bindings.CloseHandle(cmd);
    }
  }
}
