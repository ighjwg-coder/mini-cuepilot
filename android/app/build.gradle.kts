// CamCue 안드로이드 앱 — 같은 Wi-Fi 의 CamCue 서버를 찾아 CueScreen 을 띄우는 얇은 앱.
// 버전은 저장소 package.json 과 같게 맞춘다: gradle assembleRelease -PappVersion=0.0.4
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val appVersion = (findProperty("appVersion") as String?) ?: "0.0.0"
val versionParts = appVersion.split(".").map { it.toIntOrNull() ?: 0 } + listOf(0, 0, 0)

android {
    namespace = "com.camcue.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.camcue.app"
        minSdk = 24
        targetSdk = 35
        // 0.0.4 → 4, 0.1.2 → 102, 1.0.0 → 10000
        versionCode = maxOf(1, versionParts[0] * 10000 + versionParts[1] * 100 + versionParts[2])
        versionName = appVersion
    }

    signingConfigs {
        // 사내 배포용 공개 서명 키 (저장소에 포함). 같은 키로 서명해야 덮어 설치(업데이트)가 된다.
        // 플레이 스토어에 올릴 경우 비공개 키로 바꿔야 한다 — docs/DECISIONS.md 참고
        create("release") {
            storeFile = file("../camcue-release.jks")
            storePassword = "camcue-public"
            keyAlias = "camcue"
            keyPassword = "camcue-public"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}
