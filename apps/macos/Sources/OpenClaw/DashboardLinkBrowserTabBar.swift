import AppKit
import Foundation

@MainActor
protocol DashboardLinkBrowserTabBarDelegate: AnyObject {
    func tabBar(_ tabBar: DashboardLinkBrowserTabBar, didSelectTab id: UUID)
    func tabBar(_ tabBar: DashboardLinkBrowserTabBar, didCloseTab id: UUID)
    func tabBar(_ tabBar: DashboardLinkBrowserTabBar, didMoveTab id: UUID, toIndex: Int)
    func tabBar(_ tabBar: DashboardLinkBrowserTabBar, contextMenuForTab id: UUID) -> NSMenu?
}

@MainActor
final class DashboardLinkBrowserTabBar: NSView {
    weak var delegate: DashboardLinkBrowserTabBarDelegate?

    private let scrollView = NSScrollView()
    fileprivate let stackView = NSStackView()
    private var itemViews: [UUID: DashboardLinkBrowserTabItemView] = [:]

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        self.buildView()
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func appendTab(id: UUID, title: String, toolTip: String?) {
        let item = DashboardLinkBrowserTabItemView(id: id, title: title, owner: self)
        item.toolTip = toolTip
        self.itemViews[id] = item
        self.stackView.addArrangedSubview(item)
    }

    func removeTab(id: UUID) {
        guard let item = self.itemViews.removeValue(forKey: id) else { return }
        self.stackView.removeArrangedSubview(item)
        item.removeFromSuperview()
    }

    func updateTab(id: UUID, title: String, toolTip: String?) {
        guard let item = self.itemViews[id] else { return }
        item.title = title
        item.toolTip = toolTip
    }

    func setActiveTab(id: UUID?) {
        for (itemID, item) in self.itemViews {
            item.isActive = itemID == id
        }
        guard let id, let item = self.itemViews[id] else { return }
        item.scrollToVisible(item.bounds)
    }

    func moveTab(id: UUID, toIndex: Int) {
        guard let item = self.itemViews[id], self.stackView.arrangedSubviews.contains(item) else { return }
        self.stackView.removeArrangedSubview(item)
        item.removeFromSuperview()
        self.stackView.insertArrangedSubview(item, at: min(max(0, toIndex), self.stackView.arrangedSubviews.count))
    }

    fileprivate func selectTab(id: UUID) {
        self.delegate?.tabBar(self, didSelectTab: id)
    }

    fileprivate func closeTab(id: UUID) {
        self.delegate?.tabBar(self, didCloseTab: id)
    }

    fileprivate func moveTab(id: UUID, event: NSEvent) {
        guard let item = self.itemViews[id] else { return }
        let location = self.stackView.convert(event.locationInWindow, from: nil)
        let arrangedItems = self.stackView.arrangedSubviews.compactMap { $0 as? DashboardLinkBrowserTabItemView }
        guard let currentIndex = arrangedItems.firstIndex(of: item) else { return }
        let midpoints = arrangedItems.map(\.frame.midX)
        guard let targetIndex = Self.dropIndex(
            currentIndex: currentIndex,
            itemMidpoints: midpoints,
            locationX: location.x)
        else { return }
        self.delegate?.tabBar(self, didMoveTab: id, toIndex: targetIndex)
    }

    static func dropIndex(currentIndex: Int, itemMidpoints: [CGFloat], locationX: CGFloat) -> Int? {
        guard itemMidpoints.indices.contains(currentIndex) else { return nil }
        // Delegate indexes describe the array after removal. Excluding the dragged
        // item keeps rightward drops from advancing one tab too far.
        let remainingMidpoints = itemMidpoints.enumerated().compactMap { index, midpoint in
            index == currentIndex ? nil : midpoint
        }
        let targetIndex = remainingMidpoints.firstIndex { locationX < $0 } ?? remainingMidpoints.count
        return targetIndex == currentIndex ? nil : targetIndex
    }

    fileprivate func contextMenu(forTab id: UUID) -> NSMenu? {
        self.delegate?.tabBar(self, contextMenuForTab: id)
    }

    private func buildView() {
        self.scrollView.hasHorizontalScroller = false
        self.scrollView.hasVerticalScroller = false
        self.scrollView.horizontalScrollElasticity = .none
        self.scrollView.verticalScrollElasticity = .none
        self.scrollView.drawsBackground = false
        self.scrollView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(self.scrollView)

        self.stackView.orientation = .horizontal
        self.stackView.alignment = .centerY
        self.stackView.distribution = .fill
        self.stackView.spacing = 2
        self.stackView.edgeInsets = NSEdgeInsets(top: 3, left: 4, bottom: 3, right: 4)
        self.stackView.translatesAutoresizingMaskIntoConstraints = false
        self.scrollView.documentView = self.stackView

        let separator = NSBox()
        separator.boxType = .separator
        separator.translatesAutoresizingMaskIntoConstraints = false
        addSubview(separator)

        NSLayoutConstraint.activate([
            self.scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            self.scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            self.scrollView.topAnchor.constraint(equalTo: topAnchor),
            self.scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
            self.stackView.leadingAnchor.constraint(equalTo: self.scrollView.contentView.leadingAnchor),
            self.stackView.topAnchor.constraint(equalTo: self.scrollView.contentView.topAnchor),
            self.stackView.bottomAnchor.constraint(equalTo: self.scrollView.contentView.bottomAnchor),
            self.stackView.heightAnchor.constraint(equalTo: self.scrollView.contentView.heightAnchor),
            self.stackView.trailingAnchor.constraint(greaterThanOrEqualTo: self.scrollView.contentView.trailingAnchor),
            separator.leadingAnchor.constraint(equalTo: leadingAnchor),
            separator.trailingAnchor.constraint(equalTo: trailingAnchor),
            separator.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }
}

@MainActor
private final class DashboardLinkBrowserTabItemView: NSView {
    let id: UUID
    var title: String {
        didSet {
            self.titleLabel.stringValue = self.title
            self.setAccessibilityLabel(self.title)
        }
    }

    var isActive = false {
        didSet {
            self.titleLabel.textColor = self.isActive ? .labelColor : .secondaryLabelColor
            self.needsDisplay = true
        }
    }

    private weak var owner: DashboardLinkBrowserTabBar?
    private let titleLabel = NSTextField(labelWithString: "")
    private let closeButton: NSButton
    private var trackingArea: NSTrackingArea?
    private var mouseDownLocation: NSPoint?
    private var didDrag = false
    private var isHovered = false {
        didSet { self.needsDisplay = true }
    }

    init(id: UUID, title: String, owner: DashboardLinkBrowserTabBar) {
        self.id = id
        self.title = title
        self.owner = owner
        self.closeButton = Self.makeCloseButton()
        super.init(frame: .zero)

        self.setAccessibilityLabel(title)
        self.buildView()
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        // SDK 27 restores AppKit's "Color" suffix; older Swift importers expose
        // the same API as quinaryLabel.
        #if compiler(>=6.4)
        let hoverColor = NSColor.quinaryLabelColor
        #else
        let hoverColor = NSColor.quinaryLabel
        #endif
        let color: NSColor? = if self.isActive {
            .quaternaryLabelColor
        } else if self.isHovered {
            hoverColor
        } else {
            nil
        }
        guard let color else { return }
        color.setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 6, yRadius: 6).fill()
    }

    override func updateTrackingAreas() {
        if let trackingArea {
            self.removeTrackingArea(trackingArea)
        }
        let trackingArea = NSTrackingArea(
            rect: bounds,
            options: [.activeInKeyWindow, .inVisibleRect, .mouseEnteredAndExited],
            owner: self,
            userInfo: nil)
        self.addTrackingArea(trackingArea)
        self.trackingArea = trackingArea
        super.updateTrackingAreas()
    }

    override func mouseEntered(with _: NSEvent) {
        self.isHovered = true
    }

    override func mouseExited(with _: NSEvent) {
        self.isHovered = false
    }

    override func mouseDown(with event: NSEvent) {
        self.mouseDownLocation = self.convert(event.locationInWindow, from: nil)
        self.didDrag = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let mouseDownLocation else { return }
        let location = self.convert(event.locationInWindow, from: nil)
        if !self.didDrag, hypot(location.x - mouseDownLocation.x, location.y - mouseDownLocation.y) >= 4 {
            self.didDrag = true
        }
        guard self.didDrag else { return }
        self.owner?.moveTab(id: self.id, event: event)
    }

    override func mouseUp(with _: NSEvent) {
        defer {
            self.mouseDownLocation = nil
            self.didDrag = false
        }
        guard !self.didDrag else { return }
        self.owner?.selectTab(id: self.id)
    }

    override func otherMouseUp(with event: NSEvent) {
        guard event.buttonNumber == 2 else {
            super.otherMouseUp(with: event)
            return
        }
        self.owner?.closeTab(id: self.id)
    }

    override func menu(for _: NSEvent) -> NSMenu? {
        self.owner?.contextMenu(forTab: self.id)
    }

    private func buildView() {
        self.titleLabel.stringValue = self.title
        self.titleLabel.font = .systemFont(ofSize: 11, weight: .medium)
        self.titleLabel.textColor = .secondaryLabelColor
        self.titleLabel.lineBreakMode = .byTruncatingTail
        self.titleLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        self.titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        self.titleLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(self.titleLabel)

        self.closeButton.target = self
        self.closeButton.action = #selector(self.closeTab)
        self.closeButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(self.closeButton)

        NSLayoutConstraint.activate([
            widthAnchor.constraint(greaterThanOrEqualToConstant: 70),
            widthAnchor.constraint(lessThanOrEqualToConstant: 180),
            heightAnchor.constraint(equalToConstant: 24),
            self.titleLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            self.titleLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
            self.closeButton.leadingAnchor.constraint(equalTo: self.titleLabel.trailingAnchor, constant: 4),
            self.closeButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -5),
            self.closeButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            self.closeButton.widthAnchor.constraint(equalToConstant: 16),
            self.closeButton.heightAnchor.constraint(equalToConstant: 16),
        ])
    }

    private static func makeCloseButton() -> NSButton {
        let configuration = NSImage.SymbolConfiguration(pointSize: 9, weight: .medium)
        let image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close Tab")?
            .withSymbolConfiguration(configuration) ?? NSImage(size: NSSize(width: 12, height: 12))
        let button = NSButton(image: image, target: nil, action: nil)
        button.isBordered = false
        button.bezelStyle = .regularSquare
        button.imageScaling = .scaleProportionallyDown
        button.toolTip = "Close Tab"
        button.setAccessibilityLabel("Close Tab")
        return button
    }

    @objc private func closeTab() {
        self.owner?.closeTab(id: self.id)
    }
}
