plugins {
  alias(libs.plugins.android.test)
  alias(libs.plugins.ktlint)
}

android {
  namespace = "ai.openclaw.app.benchmark"
  // Match the target app while targetSdk remains an independent behavior opt-in.
  compileSdk = 37

  defaultConfig {
    minSdk = 31
    targetSdk = 36
    missingDimensionStrategy("store", "play")
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    testInstrumentationRunnerArguments["androidx.benchmark.suppressErrors"] = "DEBUGGABLE,EMULATOR"
  }

  targetProjectPath = ":app"
  experimentalProperties["android.experimental.self-instrumenting"] = true

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

kotlin {
  compilerOptions {
    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    allWarningsAsErrors.set(true)
  }
}

ktlint {
  version.set(libs.versions.ktlint.cli)
  android.set(true)
  ignoreFailures.set(false)
  filter {
    exclude("**/build/**")
  }
}

dependencies {
  implementation(libs.androidx.benchmark.macro.junit4)
  implementation(libs.androidx.test.ext.junit)
  implementation(libs.androidx.uiautomator)
}
