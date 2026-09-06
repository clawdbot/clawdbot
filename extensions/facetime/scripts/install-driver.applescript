on run argv
	if (count of argv) is not 4 then error "Expected the packaged installer, trust verifier, transaction, and mode"
	set sourceInstaller to item 1 of argv
	set sourceVerifier to item 2 of argv
	set sourceTransaction to item 3 of argv
	set installMode to item 4 of argv
	if installMode is not "--install" and installMode is not "--uninstall" then error "Expected --install or --uninstall"
	set expectedInstallerDigest to "259c9247bf6d30ee6527b68c4526f08d49aecbf795d7d69d9ab8bbff4e9c5ff6"
	set expectedVerifierDigest to "bafc2f543aa91fee6055c725aec6189d749c7c05a0e43cc42c2bb9ffd48ddad5"
	set expectedTransactionDigest to "bc15c426d8e11c454f14746392e6bccd711f9421c3be66a2e032db20937e8f82"
	set protectedCommand to "set -eu; umask 077; " & ¬
		"work=$(/usr/bin/mktemp -d /private/tmp/openclaw-driver-install.XXXXXX); " & ¬
		"cleanup() { if test -x /usr/bin/trash; then /usr/bin/trash \"$work\"; else /usr/bin/python3 -I -c 'import os, shutil, sys; p=sys.argv[1]; shutil.rmtree(p) if os.path.isdir(p) and not os.path.islink(p) else (os.unlink(p) if os.path.lexists(p) else None)' \"$work\"; fi; }; " & ¬
		"trap cleanup EXIT; /bin/chmod 700 \"$work\"; " & ¬
		"/usr/bin/ditto " & quoted form of sourceInstaller & " \"$work/install-driver-root.sh\"; " & ¬
		"/usr/bin/ditto " & quoted form of sourceVerifier & " \"$work/verify-xcode-trust.sh\"; " & ¬
		"/usr/bin/ditto " & quoted form of sourceTransaction & " \"$work/commit-driver-transaction.sh\"; " & ¬
		"/usr/sbin/chown root:wheel \"$work/install-driver-root.sh\" \"$work/verify-xcode-trust.sh\" \"$work/commit-driver-transaction.sh\"; " & ¬
		"actual=$(/usr/bin/shasum -a 256 \"$work/install-driver-root.sh\" | /usr/bin/awk '{print $1}'); " & ¬
		"test \"$actual\" = " & quoted form of expectedInstallerDigest & "; " & ¬
		"verifier_actual=$(/usr/bin/shasum -a 256 \"$work/verify-xcode-trust.sh\" | /usr/bin/awk '{print $1}'); " & ¬
		"test \"$verifier_actual\" = " & quoted form of expectedVerifierDigest & "; " & ¬
		"transaction_actual=$(/usr/bin/shasum -a 256 \"$work/commit-driver-transaction.sh\" | /usr/bin/awk '{print $1}'); " & ¬
		"test \"$transaction_actual\" = " & quoted form of expectedTransactionDigest & "; " & ¬
		"/bin/chmod 500 \"$work/install-driver-root.sh\" \"$work/verify-xcode-trust.sh\" \"$work/commit-driver-transaction.sh\"; " & ¬
		"\"$work/install-driver-root.sh\" " & quoted form of installMode
	set installCommand to "/usr/bin/env -i HOME=/var/root LOGNAME=root USER=root TMPDIR=/private/tmp PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/sh -c " & quoted form of protectedCommand
	do shell script installCommand with administrator privileges
end run
