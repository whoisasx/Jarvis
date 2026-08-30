# Getting started

This section gets a new developer from a clean checkout to a running Jarvis development build.

## Read in order

1. [Installation](installation.md)
2. [Running locally](running-locally.md)
3. [Project structure](project-structure.md)

## Development modes

Jarvis currently supports two development modes:

- Embedded Android mode: the Android app hosts the TypeScript Brain through the React Native JavaScript runtime.
- Laptop Brain mode: the Brain runs on the laptop, and the phone reaches it through `adb reverse` so the app can connect to a Node.js server for Gemini or Anthropic testing.

Laptop Brain mode is the default development path while the local embedded runtime is still maturing. The phone must be connected over USB and the ports must be reversed before the app can connect.

## Minimum successful setup

A working setup has:

- Node dependencies installed in `brain/` and `mobile/`.
- Android Studio SDK components installed.
- Metro running on port `8081`.
- A physical Android device visible through `adb devices`.
- Jarvis installed with Accessibility, notification, call/SMS, wireless, and battery permissions ready.
