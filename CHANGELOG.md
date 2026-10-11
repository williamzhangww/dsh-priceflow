# Changelog

All notable changes to dsh-priceflow are documented here.

## [0.2.1] - 2026-10-11

### Fixed

- Restore loading on DeepSeek Harness `0.2.0-rc.2` by declaring the exact prerelease versions verified by PriceFlow.

### Compatibility

- Independently verify DSH `0.2.0-rc.1` and `0.2.0-rc.2` Host, Client, route, delivery, request ID, and lifecycle contracts.
- Keep the compatibility range closed to unverified DSH prereleases and stable releases.
- No Host, Client, queue, delivery, or storage behavior changes were required.

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
