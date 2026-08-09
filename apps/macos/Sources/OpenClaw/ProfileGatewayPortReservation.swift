import Darwin
import Foundation

final class ProfileGatewayPortReservation: @unchecked Sendable {
    let port: Int
    let conflict: String?
    private let lock: AppInstanceLock?

    private init(port: Int, conflict: String?, lock: AppInstanceLock?) {
        self.port = port
        self.conflict = conflict
        self.lock = lock
    }

    static func acquire(
        profile: AppProfile,
        port: Int,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        temporaryDirectory: URL = URL(fileURLWithPath: "/tmp", isDirectory: true)) -> Self
    {
        guard let profileName = profile.name else { return Self(port: port, conflict: nil, lock: nil) }
        let lockURL = temporaryDirectory
            .appendingPathComponent("openclaw-\(geteuid())-app-profile-ports", isDirectory: true)
            .appendingPathComponent("\(port).lock")
        let lock: AppInstanceLock
        switch AppInstanceLock.acquire(url: lockURL) {
        case let .acquired(acquired): lock = acquired
        case .busy:
            return self.conflict(
                profile: profileName,
                port: port,
                reason: "another running OpenClaw profile already reserves it")
        case let .failed(reason):
            return self.conflict(
                profile: profileName,
                port: port,
                reason: "the profile reservation could not be verified (\(reason))")
        }

        if let reason = GatewayLaunchAgentManager.conflictingProfileClaimOwner(
            port: port,
            excludingLabel: profile.gatewayLaunchAgentLabel,
            homeDirectory: homeDirectory)
        {
            return self.conflict(profile: profileName, port: port, reason: reason)
        }
        return Self(port: port, conflict: nil, lock: lock)
    }

    private static func conflict(profile: String, port: Int, reason: String) -> Self {
        let message = "Profile \"\(profile)\" cannot use Gateway port \(port) because \(reason). " +
            "Set gateway.port to a free port for this profile, or stop/uninstall the other Gateway."
        return Self(
            port: port,
            conflict: message,
            lock: nil)
    }
}
