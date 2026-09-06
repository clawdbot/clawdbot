-dontwarn org.bouncycastle.**
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn com.sun.jna.**
-dontwarn javax.naming.**
-dontwarn lombok.Generated
-dontwarn org.slf4j.impl.StaticLoggerBinder
-dontwarn sun.net.spi.nameservice.NameServiceDescriptor

# WebRTC's JNI looks up Java callbacks and constructors by their original names.
-keep class org.webrtc.** { *; }
# The pinned WebRTC AAR also ships JNI Zero helpers reached only from native code.
# It has no consumer rules; R8 otherwise removes these Java entry points.
-keep class org.jni_zero.** { *; }
# This AAR omits the generated wrapper used only by JniZero.setJniClassLoader;
# OpenClaw does not call that optional setter. Do not suppress other JNI classes.
-dontwarn org.jni_zero.JniZeroJni
