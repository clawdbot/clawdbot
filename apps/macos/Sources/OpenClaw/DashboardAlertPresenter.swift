import AppKit
import SwiftUI

@MainActor
final class DashboardAlertPresenter {
    @MainActor
    private final class PendingAlert: NSObject, NSWindowDelegate {
        let alert: NSAlert
        var panel: NSPanel?
        var response: NSApplication.ModalResponse = .cancel
        var completion: ((NSApplication.ModalResponse) -> Void)?

        init(alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
            self.alert = alert
            self.completion = completion
        }

        func finish(_ response: NSApplication.ModalResponse) {
            NotificationCenter.default.removeObserver(self, name: NSWindow.willCloseNotification, object: nil)
            let completion = self.completion
            self.completion = nil
            completion?(response)
        }

        func beginSheet(on window: NSWindow) {
            // A host closed by profile removal or manager teardown never reports
            // its sheet's response; end the sheet so the completion settles.
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.hostWindowWillClose(_:)),
                name: NSWindow.willCloseNotification,
                object: window)
            self.alert.beginSheetModal(for: window) { response in
                self.finish(response)
            }
        }

        func dismiss() {
            if let panel {
                panel.close()
            } else if let parent = self.alert.window.sheetParent {
                parent.endSheet(self.alert.window, returnCode: .cancel)
            } else {
                // Queued behind another sheet, or already detached with its host.
                self.finish(.cancel)
            }
        }

        @objc private func hostWindowWillClose(_: Notification) {
            self.dismiss()
        }

        func windowWillClose(_: Notification) {
            self.panel?.contentView = nil
            self.finish(self.response)
        }
    }

    private var pending: [UUID: PendingAlert] = [:]

    func present(
        _ alert: NSAlert,
        over window: NSWindow?,
        completion: ((NSApplication.ModalResponse) -> Void)? = nil)
    {
        if alert.buttons.count <= 1,
           self.pending.values.contains(where: {
               $0.alert.buttons.count <= 1 && $0.alert.messageText == alert.messageText &&
                   $0.alert.informativeText == alert.informativeText
           })
        {
            return
        }

        let id = UUID()
        let pending = PendingAlert(alert: alert) { [weak self] response in
            self?.pending.removeValue(forKey: id)
            completion?(response)
        }
        self.pending[id] = pending

        // No nested modal loop so MainActor work and app termination keep running.
        if let window, window.isVisible {
            pending.beginSheet(on: window)
            return
        }

        let panel = DashboardAlertPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 160),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false)
        panel.title = "OpenClaw"
        panel.isReleasedWhenClosed = false
        panel.isRestorable = false
        panel.level = .floating
        panel.collectionBehavior = [.moveToActiveSpace]
        // Must stay visible while this menu-bar app is inactive.
        panel.hidesOnDeactivate = false
        panel.delegate = pending
        pending.panel = panel

        let buttonTitles = alert.buttons.isEmpty ? [String(localized: "OK")] : alert.buttons.map(\.title)
        let hostingView = NSHostingView(rootView: DashboardAlertContent(
            message: alert.messageText,
            information: alert.informativeText,
            buttonTitles: buttonTitles,
            onResponse: { [weak pending] response in
                pending?.response = response
                pending?.panel?.close()
            }))
        panel.contentView = hostingView
        panel.setContentSize(hostingView.fittingSize)
        panel.center()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    func dismissAll() {
        let pending = Array(self.pending.values)
        self.pending.removeAll()
        for presentation in pending {
            presentation.dismiss()
        }
    }
}

#if DEBUG
extension DashboardAlertPresenter {
    var _testPendingAlerts: [NSAlert] {
        self.pending.values.map(\.alert)
    }
}
#endif

@MainActor
private final class DashboardAlertPanel: NSPanel {
    override func cancelOperation(_: Any?) {
        self.close()
    }
}

@MainActor
private struct DashboardAlertContent: View {
    let message: String
    let information: String
    let buttonTitles: [String]
    let onResponse: (NSApplication.ModalResponse) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top, spacing: 16) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: 48, height: 48)
                VStack(alignment: .leading, spacing: 8) {
                    Text(self.message)
                        .font(.headline)
                    Text(self.information)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Spacer()
                ForEach(self.buttonTitles.indices, id: \.self) { index in
                    let button = Button(self.buttonTitles[index]) {
                        self.onResponse(NSApplication.ModalResponse(
                            rawValue: NSApplication.ModalResponse.alertFirstButtonReturn.rawValue + index))
                    }
                    if index == 0 {
                        button.keyboardShortcut(.defaultAction)
                    } else if index == self.buttonTitles.count - 1 {
                        button.keyboardShortcut(.cancelAction)
                    } else {
                        button
                    }
                }
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}
