# Installation

## Prerequisites

Install these before building Jarvis on Linux/Pop!_OS:

- Node.js 22 or newer
- Java 17 (required by Gradle)
- Android Studio
- Android SDK Platform 36
- Android SDK Build Tools 36.0.0
- Android SDK Platform Tools
- Android SDK Command-line Tools
- Android Emulator, if using an emulator
- CMake 3.22.1
- NDK side by side `27.1.12297006`
- A physical Android phone for realistic testing
- `adb` installed and available on PATH

Android 8/API 26 is the minimum app target. Current testing has focused on a physical Android 16/API 36 device.

## Java 17 setup

This project requires Java 17 for Gradle:

```bash
sudo apt update
sudo apt install openjdk-17-jdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH=$JAVA_HOME/bin:$PATH
java -version
javac -version
```

If your distro installs Java in a different directory, check `ls /usr/lib/jvm` and replace the `JAVA_HOME` path accordingly.

## Android Studio setup

Use Android Studio's setup wizard with the standard installation. Then open SDK Manager and verify:

- SDK Platforms: Android 16 / API 36
- SDK Tools:
  - Android SDK Build-Tools 36
  - Android SDK Platform-Tools
  - Android SDK Command-line Tools
  - Android Emulator
  - CMake
  - NDK side by side `27.1.12297006`

## Install dependencies

From the project root:

```bash
cd ~/Downloads/Projects/Jarvis-Personal_Android_Agent/brain
npm install

cd ~/Downloads/Projects/Jarvis-Personal_Android_Agent/mobile
npm install
```

The mobile package runs the Brain build automatically before `npm start` and `npm run android`.

## Environment variables

For laptop Brain mode, configure `brain/.env` before starting the server. The app currently uses the same token as the mobile config:

```env
AI_PROVIDER=openai
OPENAI_API_KEY=your-openai-key
OPENAI_MODEL=gpt-4o-mini
PHONE_AUTH_TOKEN=jarvis-local-emulator-dev-token-2026
PORT=3000
```

You can also use `AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` or `AI_PROVIDER=gemini` with `GEMINI_API_KEY` if you prefer a different provider.

## Android permissions

After installing the app, complete the setup rows in Jarvis:

1. Accessibility control
2. Notification access
3. Call, SMS, phone-state, calling, and notification runtime permissions
4. Wireless event router readiness
5. Battery exemption

Jarvis cannot force-enable Accessibility through `adb` in normal development. The user must approve it in Android settings.
