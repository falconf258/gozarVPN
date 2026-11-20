import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "app.gozarvpn.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.gozarvpn.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 28
        versionName = "0.14.0"
        // Built per CPU: arm64-v8a (ARMv8 64-bit, almost every phone since ~2017) and armeabi-v7a (old 32-bit phones); see splits below
    }

    // Release signing: the key lives outside the repository. Point GOZAR_KEYSTORE_PROPS (or the
    // gradle property gozarKeystoreProps) at a keystore.properties with storeFile/storePassword/
    // keyAlias/keyPassword; without it only debug builds are possible.
    val keyProps = (System.getenv("GOZAR_KEYSTORE_PROPS") ?: findProperty("gozarKeystoreProps") as String?)
        ?.let { file(it) }?.takeIf { it.exists() }
        ?.let { f -> Properties().apply { f.inputStream().use { load(it) } } }
    signingConfigs {
        if (keyProps != null) create("release") {
            storeFile = file(keyProps.getProperty("storeFile"))
            storePassword = keyProps.getProperty("storePassword")
            keyAlias = keyProps.getProperty("keyAlias")
            keyPassword = keyProps.getProperty("keyPassword")
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            if (keyProps != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
    // parser tests run on the JVM; android.util.* stubs return defaults instead of throwing
    testOptions { unitTests.isReturnDefaultValues = true }
    // The Aether/Tor/mihomo cores are executables shipped as lib*.so; Android only
    // extracts them to nativeLibraryDir (the one place exec is allowed) with legacy packaging.
    // engines exist only for ARM; drop the x86 libraries a dependency brings, so the universal APK does not claim x86
    packaging { jniLibs { useLegacyPackaging = true; excludes += listOf("lib/x86/**", "lib/x86_64/**") } }
    // one APK per ABI plus a universal one holding both
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a")
            isUniversalApk = true
        }
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    // sing-box core for Android (libbox.aar, built with gomobile) goes in app/libs/.
    implementation(fileTree(mapOf("dir" to "libs", "include" to listOf("*.aar", "*.jar"))))

    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.2")
    implementation(platform("androidx.compose:compose-bom:2025.07.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.google.crypto.tink:tink-android:1.18.0")

    testImplementation("junit:junit:4.13.2")
}
