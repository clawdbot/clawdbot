import OpenClawKit
import SwiftUI
import VisionKit

enum QRScannerResult: Equatable {
    case gatewayLink(GatewayConnectDeepLink)
    case setupCode(String)
}

@MainActor
struct GatewayPendingTargetSuppression {
    enum Owner: Equatable {
        case qrScanner
        case setupLink
    }

    private var value: (owner: Owner, lease: GatewayConnectionController.AutoConnectSuppressionLease)?

    mutating func replace(
        owner: Owner,
        lease: GatewayConnectionController.AutoConnectSuppressionLease)
    {
        self.value = (owner, lease)
    }

    mutating func take(ifOwnedBy owner: Owner? = nil) -> GatewayConnectionController.AutoConnectSuppressionLease? {
        guard let value = self.value else { return nil }
        if let owner, value.owner != owner {
            return nil
        }
        self.value = nil
        return value.lease
    }

    mutating func resumeAutoConnect(_ owner: Owner? = nil, controller: GatewayConnectionController) {
        guard let lease = self.take(ifOwnedBy: owner) else { return }
        controller.resumeAutoConnect(after: lease)
    }

    mutating func releaseAutoConnect(_ owner: Owner? = nil, controller: GatewayConnectionController) {
        guard let lease = self.take(ifOwnedBy: owner) else { return }
        controller.releaseAutoConnectSuppression(after: lease)
    }
}

@MainActor
final class QRScannerResultHandoff {
    /// SwiftUI's onDismiss can precede VisionKit's AV capture teardown. Delay
    /// pairing UI briefly so it cannot race the scanner's camera shutdown.
    static let defaultSettlingNanoseconds: UInt64 = 1_200_000_000

    private let settlingNanoseconds: UInt64
    private var pendingResult: QRScannerResult?
    private var deliveryTask: Task<Void, Never>?
    private var activeScanID: UInt64 = 0

    init(settlingNanoseconds: UInt64 = QRScannerResultHandoff.defaultSettlingNanoseconds) {
        self.settlingNanoseconds = settlingNanoseconds
    }

    @discardableResult
    func beginScan() -> UInt64 {
        self.cancel()
        return self.activeScanID
    }

    func isActive(scanID: UInt64) -> Bool {
        scanID == self.activeScanID && self.pendingResult == nil
    }

    @discardableResult
    func queue(_ result: QRScannerResult, scanID: UInt64) -> Bool {
        // Camera and Photos can finish together; the first valid result owns this scan.
        guard self.isActive(scanID: scanID) else { return false }
        self.pendingResult = result
        return true
    }

    @discardableResult
    func processAfterDismissal(
        _ process: @escaping @MainActor (QRScannerResult) -> Void) -> Task<Void, Never>?
    {
        guard let result = self.pendingResult else {
            self.cancel()
            return nil
        }
        self.pendingResult = nil
        self.activeScanID &+= 1
        self.deliveryTask?.cancel()
        let settlingNanoseconds = self.settlingNanoseconds
        let task = Task { @MainActor in
            do {
                try await Task.sleep(nanoseconds: settlingNanoseconds)
            } catch {
                return
            }
            process(result)
        }
        self.deliveryTask = task
        return task
    }

    func cancel() {
        self.activeScanID &+= 1
        self.deliveryTask?.cancel()
        self.deliveryTask = nil
        self.pendingResult = nil
    }
}

struct QRScannerView: UIViewControllerRepresentable {
    let onResult: (QRScannerResult) -> Void
    let onError: (String) -> Void
    let onDismiss: () -> Void

    func makeUIViewController(context: Context) -> UIViewController {
        guard DataScannerViewController.isSupported else {
            context.coordinator.reportError("QR scanning is not supported on this device.")
            return UIViewController()
        }
        guard DataScannerViewController.isAvailable else {
            context.coordinator.reportError("Camera scanning is currently unavailable.")
            return UIViewController()
        }
        return QRScannerContainerViewController(coordinator: context.coordinator)
    }

    func updateUIViewController(_: UIViewController, context _: Context) {}

    static func dismantleUIViewController(_ uiViewController: UIViewController, coordinator: Coordinator) {
        if let scanner = uiViewController as? QRScannerContainerViewController {
            scanner.stopScannerCapture()
        }
        coordinator.parent.onDismiss()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    final class QRScannerContainerViewController: UIViewController {
        private let coordinator: Coordinator
        private let scanner: DataScannerViewController
        private var didStartScanning = false

        init(coordinator: Coordinator) {
            self.coordinator = coordinator
            self.scanner = DataScannerViewController(
                recognizedDataTypes: [.barcode(symbologies: [.qr])],
                isHighlightingEnabled: true)
            super.init(nibName: nil, bundle: nil)
            self.scanner.delegate = coordinator
        }

        @available(*, unavailable)
        required init?(coder _: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        override func viewDidLoad() {
            super.viewDidLoad()
            self.view.backgroundColor = .systemBackground
            self.addChild(self.scanner)
            self.scanner.view.translatesAutoresizingMaskIntoConstraints = false
            self.view.addSubview(self.scanner.view)
            NSLayoutConstraint.activate([
                self.scanner.view.leadingAnchor.constraint(equalTo: self.view.leadingAnchor),
                self.scanner.view.trailingAnchor.constraint(equalTo: self.view.trailingAnchor),
                self.scanner.view.topAnchor.constraint(equalTo: self.view.topAnchor),
                self.scanner.view.bottomAnchor.constraint(equalTo: self.view.bottomAnchor),
            ])
            self.scanner.didMove(toParent: self)
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            // VisionKit owns the camera session; start it only after UIKit has
            // presented the scanner so sheet teardown cannot race construction.
            self.startScanningIfNeeded()
        }

        override func viewWillDisappear(_ animated: Bool) {
            self.stopScannerCapture()
            super.viewWillDisappear(animated)
        }

        func stopScannerCapture() {
            self.scanner.stopScanning()
            self.didStartScanning = false
        }

        private func startScanningIfNeeded() {
            guard !self.didStartScanning else { return }
            do {
                try self.scanner.startScanning()
                self.didStartScanning = true
            } catch {
                self.coordinator.reportError("Could not start QR scanner.")
            }
        }
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let parent: QRScannerView
        private var handled = false
        private var reportedError = false

        init(parent: QRScannerView) {
            self.parent = parent
        }

        func reportError(_ message: String) {
            guard !self.reportedError else { return }
            self.reportedError = true
            Task { @MainActor in
                self.parent.onError(message)
            }
        }

        func dataScanner(
            _ scanner: DataScannerViewController,
            didAdd items: [RecognizedItem],
            allItems _: [RecognizedItem])
        {
            guard !self.handled else { return }
            for item in items {
                guard case let .barcode(barcode) = item,
                      let payload = barcode.payloadStringValue
                else { continue }

                if let link = GatewayConnectDeepLink.fromSetupInput(payload) {
                    self.deliver(.gatewayLink(link), scanner: scanner)
                    return
                }
                if AppleReviewDemoMode.isSetupCode(payload) {
                    self.deliver(.setupCode(payload), scanner: scanner)
                    return
                }
            }
        }

        private func deliver(_ result: QRScannerResult, scanner: DataScannerViewController) {
            self.handled = true
            // DataScannerViewController has no teardown-completion callback. Stop capture
            // before owners dismiss the sheet and later present pairing UI.
            scanner.stopScanning()
            Task { @MainActor in
                self.parent.onResult(result)
            }
        }

        func dataScanner(_: DataScannerViewController, didRemove _: [RecognizedItem], allItems _: [RecognizedItem]) {}

        func dataScanner(
            _: DataScannerViewController,
            becameUnavailableWithError _: DataScannerViewController.ScanningUnavailable)
        {
            self.reportError("Camera is not available on this device.")
        }
    }
}
