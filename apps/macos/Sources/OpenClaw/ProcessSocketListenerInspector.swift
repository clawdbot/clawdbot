#if canImport(Darwin)
import Darwin

enum ProcessSocketListenerInspector {
    private static let initialDescriptorCapacity = 64
    private static let maximumDescriptorCapacity = 4096

    static func isListening(pid: pid_t, port: UInt16) -> Bool {
        guard pid > 0 else { return false }

        var capacity = self.initialDescriptorCapacity
        while capacity <= self.maximumDescriptorCapacity {
            var descriptors = [proc_fdinfo](repeating: proc_fdinfo(), count: capacity)
            let populatedBytes = descriptors.withUnsafeMutableBytes { buffer in
                proc_pidinfo(
                    pid,
                    PROC_PIDLISTFDS,
                    0,
                    buffer.baseAddress,
                    Int32(buffer.count))
            }
            guard populatedBytes > 0 else { return false }

            let descriptorStride = MemoryLayout<proc_fdinfo>.stride
            let descriptorCount = min(capacity, Int(populatedBytes) / descriptorStride)
            for descriptor in descriptors.prefix(descriptorCount)
                where descriptor.proc_fdtype == UInt32(PROX_FDTYPE_SOCKET)
            {
                if self.isListeningSocket(pid: pid, descriptor: descriptor.proc_fd, port: port) {
                    return true
                }
            }

            // A full result may be truncated. Grow and rescan so listeners with
            // high-numbered descriptors are not reported as absent.
            guard populatedBytes >= descriptors.count * descriptorStride else { return false }
            capacity *= 2
        }
        return false
    }

    private static func isListeningSocket(pid: pid_t, descriptor: Int32, port: UInt16) -> Bool {
        var socket = socket_fdinfo()
        let populatedBytes = withUnsafeMutableBytes(of: &socket) { buffer in
            proc_pidfdinfo(
                pid,
                descriptor,
                PROC_PIDFDSOCKETINFO,
                buffer.baseAddress,
                Int32(buffer.count))
        }
        guard populatedBytes == MemoryLayout<socket_fdinfo>.stride,
              socket.psi.soi_kind == SOCKINFO_TCP,
              socket.psi.soi_proto.pri_tcp.tcpsi_state == TSI_S_LISTEN
        else {
            return false
        }

        let localPort = UInt16(
            bigEndian: UInt16(
                truncatingIfNeeded: socket.psi.soi_proto.pri_tcp.tcpsi_ini.insi_lport))
        return localPort == port
    }
}
#endif
