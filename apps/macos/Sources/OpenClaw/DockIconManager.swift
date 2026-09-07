import AppKit

/// Central manager for Dock icon appearance and visibility.
/// Shows the Dock icon while any windows are visible, regardless of user preference.
final class DockIconManager: NSObject, @unchecked Sendable {
    static let shared = DockIconManager()

    private var windowsObservation: NSKeyValueObservation?
    private var appearanceObservation: NSKeyValueObservation?
    private var appliedIconResourceName: String?
    private let logger = Logger(subsystem: "ai.openclaw", category: "DockIconManager")

    override private init() {
        super.init()
        self.setupObservers()
        Task { @MainActor in
            self.updateDockVisibility()
        }
    }

    deinit {
        self.windowsObservation?.invalidate()
        self.appearanceObservation?.invalidate()
        NotificationCenter.default.removeObserver(self)
    }

    func updateDockVisibility() {
        Task { @MainActor in
            guard NSApp != nil else {
                self.logger.warning("NSApp not ready, skipping Dock visibility update")
                return
            }

            let userWantsDockHidden = (AppDefaults.standard.object(forKey: showDockIconKey) as? Bool) == false
            let visibleWindows = NSApp?.windows.filter { window in
                window.isVisible &&
                    window.frame.width > 1 &&
                    window.frame.height > 1 &&
                    !window.isKind(of: NSPanel.self) &&
                    "\(type(of: window))" != "NSPopupMenuWindow" &&
                    window.contentViewController != nil
            } ?? []

            let hasVisibleWindows = !visibleWindows.isEmpty
            let policy = Self.activationPolicy(
                launchPlan: .current,
                userWantsDockHidden: userWantsDockHidden,
                hasVisibleWindows: hasVisibleWindows)
            guard NSApp.activationPolicy() != policy else { return }
            NSApp.setActivationPolicy(policy)
        }
    }

    func temporarilyShowDock() {
        Task { @MainActor in
            guard AppLaunchRuntimePlan.current.allowsDockIcon else { return }
            guard NSApp != nil else {
                self.logger.warning("NSApp not ready, cannot show Dock icon")
                return
            }
            guard NSApp.activationPolicy() != .regular else { return }
            NSApp.setActivationPolicy(.regular)
        }
    }

    static func activationPolicy(
        launchPlan: AppLaunchRuntimePlan,
        userWantsDockHidden: Bool,
        hasVisibleWindows: Bool) -> NSApplication.ActivationPolicy
    {
        guard launchPlan.allowsDockIcon else { return .accessory }
        return !userWantsDockHidden || hasVisibleWindows ? .regular : .accessory
    }

    private func setupObservers() {
        Task { @MainActor [self] in
            guard let app = NSApp else {
                self.logger.warning("NSApp not ready, delaying Dock observers")
                try? await Task.sleep(for: .milliseconds(200))
                self.setupObservers()
                return
            }

            self.appearanceObservation = app.observe(\.effectiveAppearance, options: [
                .initial,
                .new,
            ]) { [weak self] _, _ in
                Task { @MainActor in
                    self?.updateIconImage()
                }
            }

            self.windowsObservation = app.observe(\.windows, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(50))
                    self?.updateDockVisibility()
                }
            }

            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.windowVisibilityChanged),
                name: NSWindow.didBecomeKeyNotification,
                object: nil)
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.windowVisibilityChanged),
                name: NSWindow.didResignKeyNotification,
                object: nil)
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.windowVisibilityChanged),
                name: NSWindow.willCloseNotification,
                object: nil)
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.dockPreferenceChanged),
                name: UserDefaults.didChangeNotification,
                object: nil)
        }
    }

    @objc
    private func windowVisibilityChanged(_: Notification) {
        Task { @MainActor in
            self.updateDockVisibility()
        }
    }

    @objc
    private func dockPreferenceChanged(_ notification: Notification) {
        guard let userDefaults = notification.object as? UserDefaults,
              userDefaults == AppDefaults.standard
        else { return }

        Task { @MainActor in
            self.updateDockVisibility()
            self.updateIconImage()
        }
    }

    @MainActor
    private func updateIconImage() {
        guard AppLaunchRuntimePlan.current.allowsDockIcon else { return }
        let style = AppIconStyle(rawValue: AppDefaults.standard.string(forKey: appIconStyleKey) ?? "") ?? .paper
        let appearance = AppIconAppearance(NSApp.effectiveAppearance)
        let resourceName = style.usesSystemIcon ? nil : style.resourceName(for: appearance)
        guard resourceName != self.appliedIconResourceName else { return }
        if resourceName != nil {
            guard let image = AppIconArtwork.image(for: style, appearance: appearance) else {
                self.logger.error("Bundled Dock icon is missing: \(style.resourceName(for: appearance))")
                return
            }
            NSApp.applicationIconImage = image
        } else {
            // Clearing our override restores Icon Composer's native dark, clear,
            // and tinted appearances, which have their own macOS style setting.
            NSApp.applicationIconImage = nil
        }
        self.appliedIconResourceName = resourceName
    }
}
