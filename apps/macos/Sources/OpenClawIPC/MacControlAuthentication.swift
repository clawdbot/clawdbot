import CryptoKit
import Darwin
import Foundation

public struct MacControlEnvelope: Codable, Sendable {
    public var id: String
    public var nonce: String
    public var ts: Int64
    public var requestJson: String
    public var hmac: String

    public init(request: MacControlRequest, token: String, now: Date = Date()) throws {
        self.id = UUID().uuidString
        self.nonce = UUID().uuidString
        self.ts = Int64(now.timeIntervalSince1970 * 1000)
        guard let requestJson = try String(data: JSONEncoder().encode(request), encoding: .utf8) else {
            throw MacControlError(code: "invalid_request", message: "Could not encode the control request.")
        }
        self.requestJson = requestJson
        self.hmac = Self.signature(nonce: self.nonce, ts: self.ts, requestJson: self.requestJson, token: token)
    }

    public func authenticated(token: String, now: Date = Date()) -> Bool {
        let nowMs = now.timeIntervalSince1970 * 1000
        guard !token.isEmpty, !self.nonce.isEmpty, self.nonce.utf8.count <= 128,
              abs(nowMs - Double(self.ts)) <= 15000,
              self.hmac.utf8.count == 64
        else { return false }
        let expected = Self.signature(nonce: self.nonce, ts: self.ts, requestJson: self.requestJson, token: token)
        var difference: UInt8 = 0
        for (lhs, rhs) in zip(expected.utf8, self.hmac.utf8) {
            difference |= lhs ^ rhs
        }
        return difference == 0
    }

    private static func signature(nonce: String, ts: Int64, requestJson: String, token: String) -> String {
        HMAC<SHA256>.authenticationCode(
            for: Data("\(nonce):\(ts):\(requestJson)".utf8),
            using: SymmetricKey(data: Data(token.utf8)))
            .map { String(format: "%02x", $0) }.joined()
    }
}

public enum MacControlCredentials {
    public static let tokenFilename = "mac-control.token"
    public static let socketFilename = "mac-control.sock"
    public static let maximumFrameBytes = 64 * 1024

    public static func read(at url: URL, ownerUID: uid_t = geteuid()) throws -> String {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw self.invalidCredentials() }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0,
              info.st_mode & S_IFMT == S_IFREG,
              info.st_mode & 0o777 == 0o600,
              info.st_uid == ownerUID,
              info.st_nlink == 1,
              info.st_size > 0, info.st_size <= 256
        else { throw self.invalidCredentials() }
        var bytes = [UInt8](repeating: 0, count: Int(info.st_size))
        let count = bytes.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
        guard count == bytes.count,
              let token = String(bytes: bytes, encoding: .utf8)?.trimmingCharacters(in: .newlines),
              !token.isEmpty
        else { throw self.invalidCredentials() }
        return token
    }

    /// Called only by the app while it owns the socket's lifecycle lease.
    public static func createIfMissing(at url: URL) throws -> String {
        let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else {
            if errno == EEXIST { return try self.read(at: url) }
            throw self.invalidCredentials()
        }
        defer { close(fd) }
        let token = SymmetricKey(size: .bits256).withUnsafeBytes { bytes in
            bytes.map { String(format: "%02x", $0) }.joined()
        }
        let data = Data(token.utf8)
        guard fchmod(fd, 0o600) == 0,
              data.withUnsafeBytes({ Darwin.write(fd, $0.baseAddress, $0.count) }) == data.count
        else {
            unlink(url.path)
            throw self.invalidCredentials()
        }
        return token
    }

    private static func invalidCredentials() -> MacControlError {
        MacControlError(code: "authentication_failed", message: "App control credentials are missing or unsafe.")
    }
}
