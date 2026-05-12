import com.android.build.api.variant.impl.VariantOutputImpl

val dnsjavaInetAddressResolverService = "META-INF/services/java.net.spi.InetAddressResolverProvider"

val androidStoreFile = providers.gradleProperty("OPENCLAW_ANDROID_STORE_FILE").orNull?.takeIf { it.isNotBlank() }
val androidStorePassword = providers.gradleProperty("OPENCLAW_ANDROID_STORE_PASSWORD").orNull?.takeIf { it.isNotBlank() }
val androidKeyAlias = providers.gradleProperty("OPENCLAW_ANDROID_KEY_ALIAS").orNull?.takeIf { it.isNotBlank() }
val androidKeyPassword = providers.gradleProperty("OPENCLAW_ANDROID_KEY_PASSWORD").orNull?.takeIf { it.isNotBlank() }
val resolvedAndroidStoreFile =
  androidStoreFile?.let { storeFilePath ->
    if (storeFilePath.startsWith("~/")) {
      "${System.getProperty("user.home")}/${storeFilePath.removePrefix("~/")}"
    } else {
      storeFilePath
    }
  }

val hasAndroidReleaseSigning =
  listOf(resolvedAndroidStoreFile, androidStorePassword, androidKeyAlias, androidKeyPassword).all { it != null }

val wantsAndroidReleaseBuild =
  gradle.startParameter.taskNames.any { taskName ->
    taskName.contains("Release", ignoreCase = true) ||
      Regex("""(^|:)(bundle|assemble)$""").containsMatchIn(taskName)
  }

if (wantsAndroidReleaseBuild && !hasAndroidReleaseSigning) {
  error(
    "Missing Android release signing properties. Set OPENCLAW_ANDROID_STORE_FILE, " +
      "OPENCLAW_ANDROID_STORE_PASSWORD, OPENCLAW_ANDROID_KEY_ALIAS, and " +
      "OPENCLAW_ANDROID_KEY_PASSWORD in ~/.gradle/gradle.properties.",
  )
}

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.ktlint)
  alias(libs.plugins.kotlin.compose)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "ai.openclaw.app"
  compileSdk = 36

  // Release signing is local-only; keep the keystore path and passwords out of the repo.
  signingConfigs {
    if (hasAndroidReleaseSigning) {
      create("release") {
        storeFile = project.file(checkNotNull(resolvedAndroidStoreFile))
        storePassword = checkNotNull(androidStorePassword)
        keyAlias = checkNotNull(androidKeyAlias)
        keyPassword = checkNotNull(androidKeyPassword)
      }
    }
  }

  sourceSets {
    getByName("main") {
      assets.directories.add("../../shared/OpenClawKit/Sources/OpenClawKit/Resources")
    }
  }

  defaultConfig {
    applicationId = "ai.openclaw.app"
    minSdk = 31
    targetSdk = 36
    versionCode = 2026051200
    versionName = "2026.5.12"
    ndk {
      // Support all major ABIs — native libs are tiny (~47 KB per ABI)
      abiFilters += listOf("armeabi-v7a", "arm64-v8a", "x86", "x86_64")
    }
  }

  flavorDimensions += "store"

  productFlavors {
    create("play") {
      dimension = "store"
    }
    create("thirdParty") {
      dimension = "store"
    }
  }

  buildTypes {
    release {
      if (hasAndroidReleaseSigning) {
        signingConfig = signingConfigs.getByName("release")
      }
      isMinifyEnabled = true
      isShrinkResources = true
      ndk {
        debugSymbolLevel = "SYMBOL_TABLE"
      }
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
    debug {
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
      excludes +=
        setOf(
          "/META-INF/{AL2.0,LGPL2.1}",
          "/META-INF/*.version",
          "/META-INF/LICENSE*.txt",
          "DebugProbesKt.bin",
          "kotlin-tooling-metadata.json",
          "org/bouncycastle/pqc/crypto/picnic/lowmcL1.bin.properties",
          "org/bouncycastle/pqc/crypto/picnic/lowmcL3.bin.properties",
          "org/bouncycastle/pqc/crypto/picnic/lowmcL5.bin.properties",
          "org/bouncycastle/x509/CertPathReviewerMessages*.properties",
        )
    }
  }

  lint {
    lintConfig = file("lint.xml")
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
        val flavorName = variant.flavorName?.takeIf { it.isNotBlank() }
        val outputFileName =
          if (flavorName == null) {
            "openclaw-$versionName-$buildType.apk"
          } else {
            "openclaw-$versionName-$flavorName-$buildType.apk"
          }
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

ktlint {
  android.set(true)
  ignoreFailures.set(false)
  filter {
    exclude("**/build/**")
  }
}

dependencies {
  val composeBom = platform(libs.androidx.compose.bom)
  implementation(composeBom)
  androidTestImplementation(composeBom)

  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.webkit)

  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.androidx.compose.material3)
  // material-icons-extended pulled in full icon set (~20 MB DEX). Only ~18 icons used.
  // R8 will tree-shake unused icons when minify is enabled on release builds.
  implementation(libs.androidx.compose.material.icons.extended)

  debugImplementation(libs.androidx.compose.ui.tooling)

  // Material Components (XML theme + resources)
  implementation(libs.material)

  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.kotlinx.serialization.json)

  implementation(libs.androidx.security.crypto)
  implementation(libs.androidx.exifinterface)
  implementation(libs.okhttp)
  implementation(libs.bcprov)
  implementation(libs.commonmark)
  implementation(libs.commonmark.ext.autolink)
  implementation(libs.commonmark.ext.gfm.strikethrough)
  implementation(libs.commonmark.ext.gfm.tables)
  implementation(libs.commonmark.ext.task.list.items)

  // CameraX (for node.invoke camera.* parity)
  implementation(libs.androidx.camera.core)
  implementation(libs.androidx.camera.camera2)
  implementation(libs.androidx.camera.lifecycle)
  implementation(libs.androidx.camera.video)
  implementation(libs.play.services.code.scanner)

  // Unicast DNS-SD (Wide-Area Bonjour) for tailnet discovery domains.
  implementation(libs.dnsjava)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.kotest.runner.junit5)
  testImplementation(libs.kotest.assertions.core)
  testImplementation(libs.mockwebserver)
  testImplementation(libs.robolectric)
  testRuntimeOnly(libs.junit.vintage.engine)
}

tasks.withType<Test>().configureEach {
  useJUnitPlatform()
}

androidComponents {
  onVariants(selector().withBuildType("release")) { variant ->
    val variantName = variant.name
    val variantNameCapitalized = variantName.replaceFirstChar(Char::titlecase)
    val stripTaskName = "strip${variantNameCapitalized}DnsjavaServiceDescriptor"
    val mergeTaskName = "merge${variantNameCapitalized}JavaResource"
    val minifyTaskName = "minify${variantNameCapitalized}WithR8"
    val mergedJar =
      layout.buildDirectory.file(
        "intermediates/merged_java_res/$variantName/$mergeTaskName/base.jar",
      )

    val stripTask =
      tasks.register(stripTaskName) {
        inputs.file(mergedJar)
        outputs.file(mergedJar)

        doLast {
          val jarFile = mergedJar.get().asFile
          if (!jarFile.exists()) {
            return@doLast
          }

          val unpackDir = temporaryDir.resolve("merged-java-res")
          delete(unpackDir)
          copy {
            from(zipTree(jarFile))
            into(unpackDir)
            exclude(dnsjavaInetAddressResolverService)
          }
          delete(jarFile)
          ant.invokeMethod(
            "zip",
            mapOf(
              "destfile" to jarFile.absolutePath,
              "basedir" to unpackDir.absolutePath,
            ),
          )
        }
      }

    tasks.matching { it.name == mergeTaskName }.configureEach {
      finalizedBy(stripTask)
    }
    tasks.matching { it.name == minifyTaskName }.configureEach {
      dependsOn(stripTask)
    }
  }
}
