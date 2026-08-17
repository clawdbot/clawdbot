import Darwin
import Foundation

enum ElevationExclusiveRename {
    static let argument = "--elevation-rename-exclusive"

    static func runIfRequested(arguments: [String] = CommandLine.arguments) -> Int32? {
        guard arguments.dropFirst().first == self.argument else { return nil }
        guard arguments.count == 4 else {
            fputs("OpenClaw elevation rename requires absolute source and destination paths\n", stderr)
            return 2
        }
        let source = arguments[2]
        let destination = arguments[3]
        guard source.hasPrefix("/"), destination.hasPrefix("/") else {
            fputs("OpenClaw elevation rename paths must be absolute\n", stderr)
            return 2
        }

        let result = source.withCString { sourcePath in
            destination.withCString { destinationPath in
                renamex_np(sourcePath, destinationPath, UInt32(RENAME_EXCL))
            }
        }
        guard result == 0 else {
            let code = errno
            fputs("OpenClaw elevation rename failed: \(String(cString: strerror(code)))\n", stderr)
            return 1
        }
        return 0
    }
}

enum ElevationFilesystemSync {
    static let fileArgument = "--elevation-sync-file"
    static let directoryArgument = "--elevation-sync-directory"

    static func runIfRequested(arguments: [String] = CommandLine.arguments) -> Int32? {
        guard let argument = arguments.dropFirst().first,
              argument == fileArgument || argument == directoryArgument
        else { return nil }
        guard arguments.count == 3 else {
            fputs("OpenClaw elevation sync requires one absolute path\n", stderr)
            return 2
        }
        let path = arguments[2]
        guard path.hasPrefix("/") else {
            fputs("OpenClaw elevation sync path must be absolute\n", stderr)
            return 2
        }
        let expectsDirectory = argument == self.directoryArgument
        let descriptor = open(path, O_RDONLY | O_NOFOLLOW | (expectsDirectory ? O_DIRECTORY : 0))
        guard descriptor >= 0 else {
            fputs("OpenClaw elevation sync could not open path\n", stderr)
            return 1
        }
        defer { close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              expectsDirectory ? (metadata.st_mode & S_IFMT) == S_IFDIR : (metadata.st_mode & S_IFMT) == S_IFREG
        else {
            fputs("OpenClaw elevation sync path has an unsupported type\n", stderr)
            return 1
        }
        if expectsDirectory {
            guard fsync(descriptor) == 0 else {
                fputs("OpenClaw elevation directory sync failed\n", stderr)
                return 1
            }
            return 0
        }
        guard fcntl(descriptor, F_FULLFSYNC) == 0 || fsync(descriptor) == 0 else {
            fputs("OpenClaw elevation file sync failed\n", stderr)
            return 1
        }
        let parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
        let parentDescriptor = open(parent, O_RDONLY | O_NOFOLLOW | O_DIRECTORY)
        guard parentDescriptor >= 0 else {
            fputs("OpenClaw elevation sync could not open parent directory\n", stderr)
            return 1
        }
        defer { close(parentDescriptor) }
        guard fsync(parentDescriptor) == 0 else {
            fputs("OpenClaw elevation parent directory sync failed\n", stderr)
            return 1
        }
        return 0
    }
}

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
