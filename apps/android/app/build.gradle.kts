import com.android.build.api.variant.impl.VariantOutputImpl

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.compose")
  id("org.jetbrains.kotlin.plugin.serialization")
}

android {
  namespace = "com.clawdbot.android"
  compileSdk = 36

  sourceSets {
    getByName("main") {
      assets.srcDir(file("../../shared/ClawdbotKit/Sources/ClawdbotKit/Resources"))
    }
  }

  defaultConfig {
    applicationId = "com.clawdbot.android"
    minSdk = 31
    targetSdk = 36
    versionCode = 202601260
    versionName = "2026.1.26"
  }

  buildTypes {
    release {
      isMinifyEnabled = false
    }
  }

  buildFeatures {
    compose = true
    buildConfig = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  packaging {
    resources {
      excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
  }

  lint {
    disable += setOf("IconLauncherShape")
    warningsAsErrors = true
  }

  testOptions {
    unitTests.isIncludeAndroidResources = true
  }
}

androidComponents {
  onVariants { variant ->
    variant.outputs
      .filterIsInstance<VariantOutputImpl>()
      .forEach { output ->
        val versionName = output.versionName.orNull ?: "0"
        val buildType = variant.buildType

        val outputFileName = "moltbot-${versionName}-${buildType}.apk"
        output.outputFileName = outputFileName
      }
  }
}
kotlin {
  compilerOptions {
    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    allWarningsAsErrors.set(true)
  }
}

dependencies {
  val composeBom = platform("androidx.compose:compose-bom:2025.12.00")
  implementation(composeBom)
  androidTestImplementation(composeBom)

  implementation("androidx.core:core-ktx:1.17.0")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.10.0")
  implementation("androidx.activity:activity-compose:1.12.2")
  implementation("androidx.webkit:webkit:1.15.0")

  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.ui:ui-tooling-preview")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.material:material-icons-extended")
  implementation("androidx.navigation:navigation-compose:2.9.6")

  debugImplementation("androidx.compose.ui:ui-tooling")

  // Material Components (XML theme + resources)
  implementation("com.google.android.material:material:1.13.0")

  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")

  implementation("androidx.security:security-crypto:1.1.0")
  implementation("androidx.exifinterface:exifinterface:1.4.2")
  implementation("com.squareup.okhttp3:okhttp:5.3.2")

  // CameraX (for node.invoke camera.* parity)
  implementation("androidx.camera:camera-core:1.5.2")
  implementation("androidx.camera:camera-camera2:1.5.2")
  implementation("androidx.camera:camera-lifecycle:1.5.2")
  implementation("androidx.camera:camera-video:1.5.2")
  implementation("androidx.camera:camera-view:1.5.2")

  // Unicast DNS-SD (Wide-Area Bonjour) for tailnet discovery domains.
  implementation("dnsjava:dnsjava:3.6.4")

  testImplementation("junit:junit:4.13.2")
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
  testImplementation("io.kotest:kotest-runner-junit5-jvm:6.0.7")
  testImplementation("io.kotest:kotest-assertions-core-jvm:6.0.7")
  testImplementation("org.robolectric:robolectric:4.16")
  testRuntimeOnly("org.junit.vintage:junit-vintage-engine:6.0.2")
}

tasks.withType<Test>().configureEach {
  useJUnitPlatform()
}
