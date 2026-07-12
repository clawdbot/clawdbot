import AppKit

struct DashboardNavStateMessage: Equatable {
    let collapsed: Bool
    let width: CGFloat

    static func parse(_ body: Any) -> Self? {
        guard let payload = body as? [String: Any],
              payload["type"] as? String == "nav-state",
              let collapsed = payload["collapsed"] as? Bool,
              let widthNumber = payload["width"] as? NSNumber
        else {
            return nil
        }
        let width = CGFloat(widthNumber.doubleValue)
        guard width.isFinite else { return nil }
        return Self(collapsed: collapsed, width: min(2000, max(0, width)))
    }
}

enum DashboardNavAccessoryState: Equatable {
    case legacy
    case collapsed
    case expanded(sidebarWidth: CGFloat)
}

@MainActor
final class DashboardNavAccessoryView: NSView {
    nonisolated static let compactWidth: CGFloat = 116
    // The shipped stack had no trailing inset, so its arrows ended at the 116pt
    // frame edge; the shared trailing -12 constraint needs the extra 12pt or
    // legacy (old gateway bundles) would shift back/forward left of the
    // shipped positions.
    nonisolated static let legacyWidth: CGFloat = 128
    nonisolated static let trafficLightClearance: CGFloat = 78

    private let searchButton: NSButton
    private let newSessionButton: NSButton
    private let backButton: NSButton
    private let forwardButton: NSButton
    private(set) var state = DashboardNavAccessoryState.legacy

    init(
        toggleButton: NSButton,
        searchButton: NSButton,
        newSessionButton: NSButton,
        backButton: NSButton,
        forwardButton: NSButton)
    {
        self.searchButton = searchButton
        self.newSessionButton = newSessionButton
        self.backButton = backButton
        self.forwardButton = forwardButton
        super.init(frame: NSRect(x: 0, y: 0, width: Self.compactWidth, height: 28))
        self.translatesAutoresizingMaskIntoConstraints = true

        let buttons = [toggleButton, searchButton, newSessionButton, backButton, forwardButton]
        for button in buttons {
            button.translatesAutoresizingMaskIntoConstraints = false
            self.addSubview(button)
        }
        NSLayoutConstraint.activate([
            toggleButton.leadingAnchor.constraint(equalTo: self.leadingAnchor, constant: 12),
            toggleButton.centerYAnchor.constraint(equalTo: self.centerYAnchor),
            searchButton.leadingAnchor.constraint(equalTo: toggleButton.trailingAnchor, constant: 12),
            searchButton.centerYAnchor.constraint(equalTo: self.centerYAnchor),
            newSessionButton.leadingAnchor.constraint(equalTo: searchButton.trailingAnchor, constant: 12),
            newSessionButton.centerYAnchor.constraint(equalTo: self.centerYAnchor),
            forwardButton.trailingAnchor.constraint(equalTo: self.trailingAnchor, constant: -12),
            forwardButton.centerYAnchor.constraint(equalTo: self.centerYAnchor),
            backButton.trailingAnchor.constraint(equalTo: forwardButton.leadingAnchor, constant: -12),
            backButton.centerYAnchor.constraint(equalTo: self.centerYAnchor),
        ])
        self.apply(.legacy, windowWidth: nil)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func apply(_ state: DashboardNavAccessoryState, windowWidth: CGFloat?) {
        self.state = state
        let width: CGFloat
        switch state {
        case .legacy:
            width = Self.legacyWidth
            self.searchButton.isHidden = true
            self.newSessionButton.isHidden = true
            self.backButton.isHidden = false
            self.forwardButton.isHidden = false
        case .collapsed:
            width = Self.compactWidth
            self.searchButton.isHidden = false
            self.newSessionButton.isHidden = false
            self.backButton.isHidden = true
            self.forwardButton.isHidden = true
        case let .expanded(sidebarWidth):
            let originX = self.accessoryOriginX()
            width = Self.accessoryWidth(
                sidebarWidth: sidebarWidth,
                originX: originX,
                windowWidth: windowWidth ?? Self.compactWidth + originX + 12)
            self.searchButton.isHidden = true
            self.newSessionButton.isHidden = true
            self.backButton.isHidden = false
            self.forwardButton.isHidden = false
        }
        // Frame changes make AppKit place the titlebar accessory again; button
        // constraints remain local to this frame.
        self.setFrameSize(NSSize(width: width, height: 28))
    }

    private func accessoryOriginX() -> CGFloat {
        let measured = self.window == nil ? 0 : self.convert(.zero, to: nil).x
        // Before AppKit installs the accessory there is no window-space origin;
        // use the same traffic-light clearance as the dashboard drag regions.
        return measured > 0 ? measured : Self.trafficLightClearance
    }

    nonisolated static func accessoryWidth(
        sidebarWidth: CGFloat,
        originX: CGFloat,
        windowWidth: CGFloat) -> CGFloat
    {
        let desired = sidebarWidth - originX - 12
        let available = max(Self.compactWidth, windowWidth - originX - 12)
        return min(max(Self.compactWidth, desired), available)
    }
}
