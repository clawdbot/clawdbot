import Foundation
import OpenClawProtocol

enum ComputerControlProvider: String, CaseIterable, Sendable {
    case peekaboo
    case cua

    static var peekabooComputerUseDescriptor: OpenClawProtocol.AnyCodable {
        OpenClawProtocol.AnyCodable([
            "contractVersion": 2,
            "provider": [
                "id": "peekaboo",
                "label": "Peekaboo",
                "generation": "peekaboo-v2:\(UUID().uuidString.lowercased())",
            ],
            "actions": [
                "screenshot",
                "left_click",
                "right_click",
                "middle_click",
                "double_click",
                "triple_click",
                "mouse_move",
                "left_click_drag",
                "left_mouse_down",
                "left_mouse_up",
                "scroll",
                "type",
                "key",
                "hold_key",
                "list_apps",
                "list_windows",
                "get_accessibility_tree",
                "get_cursor_position",
                "get_window_state",
                "launch_app",
                "kill_app",
                "bring_to_front",
                "set_value",
                "invoke_menu",
            ],
            "targets": ["screen", "window", "element"],
            "deliveryModes": ["background", "foreground"],
            "observations": ["image", "accessibility"],
            "features": [
                "recording": false,
                "agentCursor": false,
                "multiDisplay": true,
            ],
        ] as [String: Any])
    }

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

struct CuaDriverWorkerEndpoint: Encodable, Equatable, Sendable {
    private let v = 1
    let socketPath: String
    let binaryPath: String

    func environmentValue() throws -> String {
        try String(bytes: JSONEncoder().encode(self), encoding: .utf8)!
    }
}

enum CuaDriverWorkerEnvironment {
    static let endpoint = "OPENCLAW_CUA_DRIVER_ENDPOINT"
    static let inheritedFamilyPrefixes = [String(endpoint.dropLast("ENDPOINT".count)), "CUA_DRIVER_"]
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
