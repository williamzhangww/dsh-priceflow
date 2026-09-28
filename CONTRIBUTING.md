# Contributing

## Requirements

- Node.js 20 or newer
- DSH 0.2.0-rc.1 for runtime smoke checks

## Development checks

Run:

```sh
npm test
npm run check
npm run verify
git diff --check
```

## Principles

- Do not include secrets or personal paths in changes or reports.
- Keep PricingEngine as the single source of truth for phase and scheduling decisions.
- Scheduling must fail closed when the policy is unverified.
- CNY display must never drive scheduling.
- Queue semantics remain durable and at-least-once.
- `submitted` means DSH accepted the submission; it does not mean the model completed a response.
