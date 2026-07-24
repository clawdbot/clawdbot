import Darwin
import Foundation

func sendExecApprovalSocketResponse(
    handle: FileHandle,
    id: String,
    decision: ExecApprovalDecision) throws
{
    let response = ExecApprovalSocketDecision(type: "decision", id: id, decision: decision)
    var payload = try JSONEncoder().encode(response)
    payload.append(0x0A)
    try handle.write(contentsOf: payload)
}

func sendExecHostSocketResponse(handle: FileHandle, response: ExecHostResponse) throws {
    var payload = try JSONEncoder().encode(response)
    payload.append(0x0A)
    try handle.write(contentsOf: payload)
}

func isExecApprovalsSocketPeerAllowed(fd: Int32) -> Bool {
    var uid = uid_t(0)
    var gid = gid_t(0)
    guard getpeereid(fd, &uid, &gid) == 0 else {
        return false
    }
    return uid == geteuid()
}
