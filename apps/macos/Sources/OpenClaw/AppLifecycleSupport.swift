import Darwin
import Dispatch
import Foundation
import Observation
import Security

enum AppInstanceLockAcquisition {
    case acquired(AppInstanceLock)
    case busy
    case failed(String)
}

final class AppInstanceLock {
    /// Keep the descriptor open for the process lifetime. Never unlink the path:
    /// another opener could then lock a different inode and admit a duplicate.
    private let descriptor: Int32

    private init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    static func acquire(url: URL, waitMilliseconds: Int = 0) -> AppInstanceLockAcquisition {
        if let error = self.preparePrivateStateRoot(url.deletingLastPathComponent()) {
            return .failed(error)
        }
        let descriptor = Darwin.open(url.path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { return .failed(String(cString: strerror(errno))) }
        var status = stat()
        guard fstat(descriptor, &status) == 0,
              status.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              status.st_uid == geteuid()
        else {
            Darwin.close(descriptor)
            return .failed("Instance lock is not a safe file owned by the current user.")
        }
        _ = fchmod(descriptor, 0o600)
        let deadline = DispatchTime.now() + .milliseconds(max(0, waitMilliseconds))
        while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
            guard errno == EWOULDBLOCK, DispatchTime.now() < deadline else {
                let result: AppInstanceLockAcquisition = errno == EWOULDBLOCK
                    ? .busy
                    : .failed(String(cString: strerror(errno)))
                Darwin.close(descriptor)
                return result
            }
            usleep(50000)
        }
        return .acquired(AppInstanceLock(descriptor: descriptor))
    }

    private static func preparePrivateStateRoot(_ root: URL) -> String? {
        var status = stat()
        if lstat(root.path, &status) != 0 {
            guard errno == ENOENT else { return String(cString: strerror(errno)) }
            guard mkdir(root.path, 0o700) == 0 else { return String(cString: strerror(errno)) }
            guard lstat(root.path, &status) == 0 else { return String(cString: strerror(errno)) }
        }
        guard status.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              status.st_uid == geteuid(),
              status.st_mode & 0o777 == 0o700
        else {
            return "App profile state directory must be an owner-only 0700 directory."
        }
        return nil
    }

    deinit {
        _ = flock(self.descriptor, LOCK_UN)
        Darwin.close(self.descriptor)
    }
}

@MainActor
protocol UpdaterProviding: AnyObject {
    var automaticallyChecksForUpdates: Bool { get set }
    var automaticallyDownloadsUpdates: Bool { get set }
    var isAvailable: Bool { get }
    var updateStatus: UpdateStatus { get }
    func start()
    func startAfterResolvingGatewayUpdateChannel()
    func checkForUpdates(_ sender: Any?)
}

extension UpdaterProviding {
    func start() {}

    func startAfterResolvingGatewayUpdateChannel() {
        self.start()
    }
}

/// No-op updater used for debug/dev runs to suppress Sparkle dialogs.
final class DisabledUpdaterController: UpdaterProviding {
    var automaticallyChecksForUpdates: Bool = false
    var automaticallyDownloadsUpdates: Bool = false
    let isAvailable: Bool = false
    let updateStatus = UpdateStatus()
    func checkForUpdates(_: Any?) {}
}

@MainActor
@Observable
final class UpdateStatus {
    var isUpdateReady: Bool

    init(isUpdateReady: Bool = false) {
        self.isUpdateReady = isUpdateReady
    }
}

#if canImport(Sparkle)
import Sparkle

@MainActor
final class SparkleUpdaterController: NSObject, UpdaterProviding {
    private lazy var controller = SPUStandardUpdaterController(
        startingUpdater: false,
        updaterDelegate: self,
        userDriverDelegate: nil)
    let updateStatus = UpdateStatus()
    private var started = false
    private var gatewayUpdateChannel: String?
    private var resolvingGatewayUpdateChannel = false
    private let gatewayUpdateChannelResolver: @MainActor @Sendable () async throws -> String?
    private let onStart: (() -> Void)?

    init(
        savedAutoUpdate: Bool,
        gatewayUpdateChannelResolver: (@MainActor @Sendable () async throws -> String?)? = nil,
        onStart: (() -> Void)? = nil)
    {
        self.gatewayUpdateChannelResolver = gatewayUpdateChannelResolver ?? {
            struct UpdateStatusResponse: Decodable {
                let effectiveChannel: String?
            }
            guard let data = try? await GatewayConnection.shared.requestRaw(
                method: "update.status",
                timeoutMs: 5000),
                let response = try? JSONDecoder().decode(UpdateStatusResponse.self, from: data)
            else { return nil }
            return OpenClawConfigFile.normalizedGatewayUpdateChannel(response.effectiveChannel)
        }
        self.onStart = onStart
        super.init()
        let updater = self.controller.updater
        updater.automaticallyChecksForUpdates = savedAutoUpdate
        updater.automaticallyDownloadsUpdates = savedAutoUpdate
    }

    func start() {
        guard !self.started else { return }
        self.started = true
        if let onStart = self.onStart {
            onStart()
        } else {
            self.controller.startUpdater()
        }
    }

    func startAfterResolvingGatewayUpdateChannel() {
        guard !self.started, !self.resolvingGatewayUpdateChannel else { return }
        self.resolvingGatewayUpdateChannel = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.resolvingGatewayUpdateChannel = false }
            self.gatewayUpdateChannel = try? await self.gatewayUpdateChannelResolver()
            // Older or unreachable Gateways cannot report effectiveChannel. Preserve
            // their existing stable Sparkle behavior instead of disabling updates.
            self.start()
        }
    }

    var automaticallyChecksForUpdates: Bool {
        get { self.controller.updater.automaticallyChecksForUpdates }
        set { self.controller.updater.automaticallyChecksForUpdates = newValue }
    }

    var automaticallyDownloadsUpdates: Bool {
        get { self.controller.updater.automaticallyDownloadsUpdates }
        set { self.controller.updater.automaticallyDownloadsUpdates = newValue }
    }

    var isAvailable: Bool {
        self.started
    }

    func checkForUpdates(_ sender: Any?) {
        guard self.started else { return }
        self.controller.checkForUpdates(sender)
    }

    func updater(_: SPUUpdater, didDownloadUpdate _: SUAppcastItem) {
        self.updateStatus.isUpdateReady = true
    }

    func updater(_: SPUUpdater, failedToDownloadUpdate _: SUAppcastItem, error _: Error) {
        self.updateStatus.isUpdateReady = false
    }

    func userDidCancelDownload(_: SPUUpdater) {
        self.updateStatus.isUpdateReady = false
    }

    // periphery:ignore - Sparkle invokes this optional Objective-C delegate callback dynamically.
    func updater(
        _: SPUUpdater,
        userDidMakeChoice choice: SPUUserUpdateChoice,
        forUpdate _: SUAppcastItem,
        state: SPUUserUpdateState)
    {
        switch choice {
        case .install, .skip:
            self.updateStatus.isUpdateReady = false
        case .dismiss:
            self.updateStatus.isUpdateReady = (state.stage == .downloaded)
        @unknown default:
            self.updateStatus.isUpdateReady = false
        }
    }
}

func allowedSparkleChannels(forGatewayUpdateChannel channel: String?) -> Set<String> {
    switch channel {
    case "beta", "dev":
        ["beta"]
    case "extended-stable":
        ["extended-stable"]
    default:
        []
    }
}

func isSparkleUpdateAllowed(itemChannel: String?, forGatewayUpdateChannel channel: String?) -> Bool {
    channel != "extended-stable" || itemChannel == "extended-stable"
}

extension SparkleUpdaterController: SPUUpdaterDelegate {
    func allowedChannels(for _: SPUUpdater) -> Set<String> {
        allowedSparkleChannels(
            forGatewayUpdateChannel: self.gatewayUpdateChannel ?? OpenClawConfigFile.gatewayUpdateChannel())
    }

    func bestValidUpdate(in appcast: SUAppcast, for _: SPUUpdater) -> SUAppcastItem? {
        guard self.gatewayUpdateChannel ?? OpenClawConfigFile.gatewayUpdateChannel() == "extended-stable" else {
            return nil
        }
        let comparator = SUStandardVersionComparator.default
        let currentVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        // Sparkle always admits the default channel. Filter it here so an
        // extended-stable Gateway is never prompted to leave its release train.
        let eligibleItems = appcast.items.filter {
            guard isSparkleUpdateAllowed(
                itemChannel: $0.channel,
                forGatewayUpdateChannel: "extended-stable")
            else { return false }
            guard let currentVersion else { return true }
            return comparator.compareVersion(
                $0.versionString,
                toVersion: currentVersion) == .orderedDescending
        }
        return eligibleItems.max { left, right in
            comparator.compareVersion(left.versionString, toVersion: right.versionString) == .orderedAscending
        }
    }

    func updater(_: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        guard let currentVersion = GatewayEnvironment.appVersionString() else { return }
        PostAppUpdateReceiptStore.record(
            fromVersion: currentVersion,
            toVersion: item.displayVersionString)
    }
}

private func isDeveloperIDSigned(bundleURL: URL) -> Bool {
    var staticCode: SecStaticCode?
    guard SecStaticCodeCreateWithPath(bundleURL as CFURL, SecCSFlags(), &staticCode) == errSecSuccess,
          let code = staticCode
    else { return false }

    var infoCF: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &infoCF) == errSecSuccess,
          let info = infoCF as? [String: Any],
          let certs = info[kSecCodeInfoCertificates as String] as? [SecCertificate],
          let leaf = certs.first
    else {
        return false
    }

    if let summary = SecCertificateCopySubjectSummary(leaf) as String? {
        return summary.hasPrefix("Developer ID Application:")
    }
    return false
}

@MainActor
func makeUpdaterController() -> UpdaterProviding {
    guard AppProfile.current.validationError == nil, !AppProfile.current.isActive else {
        return DisabledUpdaterController()
    }
    let bundleURL = Bundle.main.bundleURL
    let isBundledApp = bundleURL.pathExtension == "app"
    guard isBundledApp, isDeveloperIDSigned(bundleURL: bundleURL) else { return DisabledUpdaterController() }

    let defaults = AppDefaults.standard
    let autoUpdateKey = "autoUpdateEnabled"
    // Default to true; honor the user's last choice otherwise.
    let savedAutoUpdate = (defaults.object(forKey: autoUpdateKey) as? Bool) ?? true
    return SparkleUpdaterController(savedAutoUpdate: savedAutoUpdate)
}
#else
@MainActor
func makeUpdaterController() -> UpdaterProviding {
    DisabledUpdaterController()
}
#endif
