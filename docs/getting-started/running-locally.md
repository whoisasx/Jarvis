# Running locally

## Current setup: laptop-hosted Brain

The current supported development flow runs the TypeScript Brain on the laptop and exposes the port to the phone through ADB reverse. This is the path that is working for local testing with Gemini, Anthropic, or OpenAI.

### 1) Start the Brain

```bash
cd ~/Downloads/Projects/Jarvis-Personal_Android_Agent/brain
npm install
npm run build
npm start
```

The server listens on `http://0.0.0.0:3000` and serves the phone websocket at `ws://127.0.0.1:3000/phone`.

### 2) Make sure Java 17 is active

```bash
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH=$JAVA_HOME/bin:$PATH
java -version
```

If your distro uses a different JDK path, replace it with the value from `ls /usr/lib/jvm`.

### 3) Forward ports to the phone

First confirm your device is visible:

```bash
adb devices
```

Then reverse the ports:

```bash
adb reverse tcp:3000 tcp:3000
adb reverse tcp:8081 tcp:8081
```

This is required so the Android app can reach the Brain through the laptop.

### 4) Start Metro

```bash
cd ~/Downloads/Projects/Jarvis-Personal_Android_Agent/mobile
npm install
npm start -- --reset-cache --port 8081
```

### 5) Install the app on the phone

In a second terminal:

```bash
cd ~/Downloads/Projects/Jarvis-Personal_Android_Agent/mobile
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH=$JAVA_HOME/bin:$PATH
npm run android -- --port 8081 --no-packager
```

`--no-packager` is intentional because Metro is already running.

## Configuration

The app is configured for laptop Brain mode in `mobile/src/config.ts`:

```ts
export const JARVIS_CONFIG = {
  brainWebSocketUrl: 'ws://127.0.0.1:3000/phone',
  phoneAuthToken: 'jarvis-local-emulator-dev-token-2026',
};
```

The Brain must use the same token in `brain/.env`:

```env
PHONE_AUTH_TOKEN=jarvis-local-emulator-dev-token-2026
```

## Verify the Brain is live

```bash
curl http://localhost:3000/health
```

Expected fields include `ok: true`, provider, phone connection, `orchestration`, and `gateway`.

List tools:

```bash
curl -H "Authorization: Bearer $PHONE_AUTH_TOKEN" http://localhost:3000/v1/tools
```

## Port cleanup

If the ports are stale, inspect them:

```bash
lsof -i :3000 -i :8081
```

Or stop and restart the Android reverse tunnel if needed:

```bash
adb reverse --remove tcp:3000
adb reverse --remove tcp:8081
adb reverse tcp:3000 tcp:3000
adb reverse tcp:8081 tcp:8081
```
