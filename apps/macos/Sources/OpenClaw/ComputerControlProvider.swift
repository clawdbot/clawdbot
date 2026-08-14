import Foundation

enum ComputerControlProvider: String, CaseIterable, Sendable {
    case peekaboo
    case cua

    static func current(
        defaults: UserDefaults = AppDefaults.standard,
        cuaAvailable: Bool = CuaDriverArtifact.bundledExecutableURL != nil) -> Self
    {
        guard let rawValue = defaults.string(forKey: computerControlProviderKey),
              let provider = Self(rawValue: rawValue)
        else { return .peekaboo }
        if provider == .cua, !cuaAvailable { return .peekaboo }
        return provider
    }

    var displayName: String {
        switch self {
        case .peekaboo: "Peekaboo"
        case .cua: "CUA"
        }
    }
}

struct CuaDriverWorkerEndpoint: Equatable, Sendable {
    let socketPath: String
    let binaryPath: String
}

enum CuaDriverWorkerEnvironment {
    static let socketPath = "OPENCLAW_CUA_DRIVER_SOCKET_PATH"
    static let binaryPath = "OPENCLAW_CUA_DRIVER_BINARY_PATH"
}

enum CuaDriverArtifact {
    static let resourceName = "cua-driver"

    static var bundledExecutableURL: URL? {
        self.executableURL(in: Bundle.main.resourceURL)
    }

    static func executableURL(
        in resourceURL: URL?,
        fileManager: FileManager = .default) -> URL?
    {
        guard let resourceURL else { return nil }
        let candidate = resourceURL.appendingPathComponent(self.resourceName, isDirectory: false)
        guard let values = try? candidate.resourceValues(forKeys: [
            .isRegularFileKey,
            .isSymbolicLinkKey,
        ]),
            values.isRegularFile == true,
            values.isSymbolicLink != true,
            fileManager.isExecutableFile(atPath: candidate.path)
        else { return nil }
        return candidate
    }
}
