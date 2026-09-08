import AppKit
import KeyboardShortcuts
import SwiftUI

@MainActor
final class DeviceSettingsPanels: NSObject, NSWindowDelegate {
    static let shared = DeviceSettingsPanels()
    private var panel: NSPanel?
    private var onClose: (() -> Void)?
    private var microphoneTest: DeviceMicrophoneTestModel?

    func showQuickChatShortcut(parentWindow: NSWindow?, onClose: @escaping () -> Void) {
        self.show(title: String(localized: "Quick Chat shortcut"), parentWindow: parentWindow, onClose: onClose) {
            KeyboardShortcuts.Recorder(for: .toggleQuickChat)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
        }
    }

    func showMicrophoneTest(parentWindow: NSWindow?, state: AppState, onClose: @escaping () -> Void) {
        let model = DeviceMicrophoneTestModel(state: state)
        self.show(title: String(localized: "Microphone Test"), parentWindow: parentWindow, onClose: onClose) {
            DeviceMicrophoneTestView(model: model)
        }
        self.microphoneTest = model
        model.start()
    }

    private func show(
        title: String,
        parentWindow: NSWindow?,
        onClose: @escaping () -> Void,
        @ViewBuilder content: () -> some View)
    {
        self.close()
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 160),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false)
        panel.title = title
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        let hostingView = NSHostingView(rootView: VStack(alignment: .leading, spacing: 16) {
            content()
            HStack {
                Spacer()
                Button("Done") { [weak self] in self?.close() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 460))
        panel.contentView = hostingView
        panel.setContentSize(hostingView.fittingSize)
        self.panel = panel
        self.onClose = onClose
        if let parentWindow {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.parentWindowWillClose(_:)),
                name: NSWindow.willCloseNotification,
                object: parentWindow)
        }
        if let parentWindow, parentWindow.attachedSheet == nil {
            parentWindow.beginSheet(panel)
        } else {
            panel.center()
            panel.makeKeyAndOrderFront(nil)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    private func close() {
        guard let panel else { return }
        if let parent = panel.sheetParent {
            parent.endSheet(panel)
        }
        panel.close()
    }

    @objc private func parentWindowWillClose(_: Notification) {
        self.close()
    }

    func windowWillClose(_ notification: Notification) {
        guard let closingWindow = notification.object as? NSWindow, closingWindow === self.panel else { return }
        NotificationCenter.default.removeObserver(self, name: NSWindow.willCloseNotification, object: nil)
        // The presenting window owns the audio lifetime, including when a sheet's parent closes.
        self.microphoneTest?.stop()
        self.microphoneTest = nil
        self.panel?.contentView = nil
        self.panel = nil
        let onClose = self.onClose
        self.onClose = nil
        onClose?()
    }
}
