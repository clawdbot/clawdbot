import Foundation

struct AppLaunchRuntimePlan: Equatable {
    enum Mode: Equatable {
        case interactive
        case background
        case elevationHost
    }

    let mode: Mode
    let attachOnly: Bool

    init(arguments: [String]) {
        if arguments.contains("--elevation-host") {
            self.mode = .elevationHost
            self.attachOnly = true
        } else {
            self.mode = arguments.contains("--background-only") ? .background : .interactive
            self.attachOnly = arguments.contains("--attach-only") || arguments.contains("--no-launchd")
        }
    }

    static var current: Self {
        Self(arguments: CommandLine.arguments)
    }

    var isElevationHost: Bool {
        self.mode == .elevationHost
    }

    var allowsAutomaticPresentation: Bool {
        self.mode == .interactive
    }

    /// GUI-owned Keychain items may present SecurityAgent when a newly signed build is not in an item's ACL.
    /// Background hosts keep that state cold; config and environment still own their primary Gateway route.
    var allowsGatewayUIKeychainAccess: Bool {
        self.mode == .interactive
    }

    var allowsUpdater: Bool {
        !self.isElevationHost
    }

    var allowsDockIcon: Bool {
        !self.isElevationHost
    }

    var allowsInteractiveServices: Bool {
        !self.isElevationHost
    }

    func shouldAutoOpenChat(arguments: [String]) -> Bool {
        self.allowsAutomaticPresentation &&
            (arguments.contains("--chat") || arguments.contains("--webchat"))
    }

    func shouldAutoOpenDashboard(arguments: [String]) -> Bool {
        self.allowsAutomaticPresentation && arguments.contains("--dashboard")
    }
}
