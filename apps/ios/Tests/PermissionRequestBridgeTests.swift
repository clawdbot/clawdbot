import Photos
import Testing
@testable import OpenClaw

@Suite(.serialized) struct PermissionRequestBridgeTests {
    @Test func `box resumes immediately when cancelled before install`() async {
        let box = PermissionRequestBridge.Box()
        box.resume(false)
        let granted: Bool = await withCheckedContinuation { continuation in
            _ = box.install(continuation)
        }
        #expect(granted == false)
        #expect(box.canStartRequest() == false)
    }

    @Test func `box resumes installed continuation once`() async {
        let box = PermissionRequestBridge.Box()

        let granted: Bool = await withCheckedContinuation { continuation in
            _ = box.install(continuation)
            box.resume(true)
            box.resume(false)
        }

        #expect(granted == true)
    }
}

struct PhotoLibraryAccessTests {
    @Test(arguments: [PHAuthorizationStatus.authorized, .limited])
    func `read access includes full and limited authorization`(_ status: PHAuthorizationStatus) {
        #expect(PhotoLibraryAccess.canRead(status))
    }

    @Test(arguments: [PHAuthorizationStatus.notDetermined, .denied, .restricted])
    func `read access excludes unavailable authorization`(_ status: PHAuthorizationStatus) {
        #expect(!PhotoLibraryAccess.canRead(status))
    }
}
