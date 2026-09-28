# Changelog

All notable changes to dsh-priceflow are documented here.

## [0.2.0] - 2026-09-28

Initial public release.

### Added

- Official DeepSeek pricing policy refresh and validation.
- USD and CNY pricing display, PEAK/OFF-PEAK status, and transition countdown.
- Holiday-aware scheduling and a durable text queue with restart recovery.
- Optional DeepSeek account balance display.

### Reliability

- Fail-closed scheduling when pricing policy or required holiday coverage is not verified.
- At-least-once queue delivery architecture.

### Compatibility

- Support verified against DSH 0.2.0-rc.1.
