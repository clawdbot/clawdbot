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
    id("com.android.application")
    id("org.jlleitschuh.gradle.ktlint")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
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
        versionCode = 2026041401
        versionName = "2026.4.14"
        ndk {
            // Support all major ABIs — native libs are tiny (~47 KB per ABI)
            abiFilters += listOf("armeabi-v7a", "arm64-v8a", "x86", "x86_64")
        }
    }

    flavorDimensions += "store"

    productFlavors {
        create("play") {
            dimension = "store"
            buildConfigField("boolean", "OPENCLAW_ENABLE_SMS", "false")
            buildConfigField("boolean", "OPENCLAW_ENABLE_CALL_LOG", "false")
        }
        create("thirdParty") {
            dimension = "store"
            buildConfigField("boolean", "OPENCLAW_ENABLE_SMS", "true")
            buildConfigField("boolean", "OPENCLAW_ENABLE_CALL_LOG", "true")
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
        disable +=
            setOf(
                "AndroidGradlePluginVersion",
                "GradleDependency",
                "IconLauncherShape",
                "NewerVersionAvailable",
            )
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
    val composeBom = platform("androidx.compose:compose-bom:2026.02.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.10.0")
    implementation("androidx.activity:activity-compose:1.12.2")
    implementation("androidx.webkit:webkit:1.15.0")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    // material-icons-extended pulled in full icon set (~20 MB DEX). Only ~18 icons used.
    // R8 will tree-shake unused icons when minify is enabled on release builds.
    implementation("androidx.compose.material:material-icons-extended")

    debugImplementation("androidx.compose.ui:ui-tooling")

    // Material Components (XML theme + resources)
    implementation("com.google.android.material:material:1.13.0")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.10.0")

    implementation("androidx.security:security-crypto:1.1.0")
    implementation("androidx.exifinterface:exifinterface:1.4.2")
    implementation("com.squareup.okhttp3:okhttp:5.3.2")
    implementation("org.bouncycastle:bcprov-jdk18on:1.83")
    implementation("org.commonmark:commonmark:0.27.1")
    implementation("org.commonmark:commonmark-ext-autolink:0.27.1")
    implementation("org.commonmark:commonmark-ext-gfm-strikethrough:0.27.1")
    implementation("org.commonmark:commonmark-ext-gfm-tables:0.27.1")
    implementation("org.commonmark:commonmark-ext-task-list-items:0.27.1")

    // CameraX (for node.invoke camera.* parity)
    implementation("androidx.camera:camera-core:1.5.2")
    implementation("androidx.camera:camera-camera2:1.5.2")
    implementation("androidx.camera:camera-lifecycle:1.5.2")
    implementation("androidx.camera:camera-video:1.5.2")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")

    // Unicast DNS-SD (Wide-Area Bonjour) for tailnet discovery domains.
    implementation("dnsjava:dnsjava:3.6.4")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("io.kotest:kotest-runner-junit5-jvm:6.1.3")
    testImplementation("io.kotest:kotest-assertions-core-jvm:6.1.3")
    testImplementation("com.squareup.okhttp3:mockwebserver:5.3.2")
    testImplementation("org.robolectric:robolectric:4.16.1")
    testRuntimeOnly("org.junit.vintage:junit-vintage-engine:6.0.2")
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
