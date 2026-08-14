import Foundation

struct AppLaunchPresentationPolicy: Equatable {
    let backgroundOnly: Bool

    init(arguments: [String]) {
        self.backgroundOnly = arguments.contains("--background-only")
    }

    static var current: Self {
        Self(arguments: CommandLine.arguments)
    }

    var allowsAutomaticPresentation: Bool {
        !self.backgroundOnly
    }

    /// GUI-owned Keychain items may present SecurityAgent when a newly signed build is not in an item's ACL.
    /// Background hosts keep that state cold; config and environment still own their primary Gateway route.
    var allowsGatewayUIKeychainAccess: Bool {
        !self.backgroundOnly
    }

    func shouldAutoOpenChat(arguments: [String]) -> Bool {
        self.allowsAutomaticPresentation &&
            (arguments.contains("--chat") || arguments.contains("--webchat"))
    }

    func shouldAutoOpenDashboard(arguments: [String]) -> Bool {
        self.allowsAutomaticPresentation && arguments.contains("--dashboard")
    }
}
