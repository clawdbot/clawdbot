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
                owner: "another running OpenClaw profile")
        case let .failed(reason):
            return self.conflict(
                profile: profileName,
                port: port,
                owner: "an unverifiable profile reservation (\(reason))")
        }

        if let owner = GatewayLaunchAgentManager.conflictingProfileClaimOwner(
            port: port,
            excludingLabel: profile.gatewayLaunchAgentLabel,
            homeDirectory: homeDirectory)
        {
            return self.conflict(profile: profileName, port: port, owner: owner)
        }
        return Self(port: port, conflict: nil, lock: lock)
    }

    private static func conflict(profile: String, port: Int, owner: String) -> Self {
        let message = "Profile \"\(profile)\" cannot use Gateway port \(port) because \(owner) reserves it. " +
            "Set gateway.port to a free port for this profile, or stop/uninstall the other Gateway."
        return Self(
            port: port,
            conflict: message,
            lock: nil)
    }
}
