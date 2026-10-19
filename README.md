# dsh-priceflow

DeepSeek pricing and off-peak scheduling for DeepSeek Harness.

[中文文档](README.zh-CN.md)

## What it does

PriceFlow adds a status panel and an explicit off-peak action to the DSH conversation composer. It displays the current PEAK or OFF-PEAK phase, a countdown to the next transition, official USD pricing, and official Chinese-page CNY pricing. CNY is shown as published; it is not converted from USD and does not drive scheduling.

During PEAK, you can queue a text message for OFF-PEAK delivery. During OFF-PEAK, ordinary DSH sending remains the normal send flow. PriceFlow can also show your DeepSeek account balance when DSH credentials are available.

## Requirements

- Node.js 20 or newer
- DeepSeek Harness `>=0.2.0-rc.1 <0.3.0-0` (DSH prereleases included)

PriceFlow has been tested against DSH `0.2.0-rc.1` and `0.2.0-rc.2`. Future `0.2.x` versions are admitted by the range but are not individually API-verified; Host or Client API changes may require a plugin fix.

## Installation

In a terminal, add the npm package to the profile where you want PriceFlow installed:

```sh
dsh plugin --profile <profile> add dsh-priceflow
```

Replace `<profile>` with the DSH profile name. The declared DSH range is bounded below `0.3.0`; no version exemption is used. In DSH Desktop builds that expose an in-app Plugins page, use that page to install the package into the Desktop profile.

## Features

### Phase and countdown

PriceFlow uses the official DeepSeek pricing schedule to show PEAK and OFF-PEAK and the time until the next transition. Phase comes from the Host pricing engine; the Client does not calculate or flip it locally.

### USD and CNY pricing

USD prices come from DeepSeek's official pricing page. CNY prices come from DeepSeek's official Chinese pricing page. CNY is display-only and never changes the scheduler's USD pricing policy.

### Off-peak queue

During PEAK, the PriceFlow action can queue text for OFF-PEAK delivery. During OFF-PEAK, ordinary DSH sends follow the normal DSH flow. Delayed queue sends are text-only; attachments are not supported. Queue data survives Host restarts. Delivery uses a durable at-least-once architecture, so a message may be attempted again after an interrupted delivery. A missing send API, an API error, or a response without the explicit `accepted: true` contract is rejected; the queued message is retained and is never marked submitted on that basis. Retryable failures use capped backoff and a finite attempt limit. A `submitted` status means DSH accepted the submission; it does not mean the model completed its response. Delivery remains at-least-once, not exactly-once, so an interrupted request may have an uncertain outcome.

### Pricing trust

PriceFlow reads official DeepSeek pricing sources and validates the result before using it. A verified Last Known Good (LKG) policy can continue to be used after a refresh failure, with a stale-data warning. A bundled pricing fixture is for reference only and does not authorize scheduling. If a model's price is unknown, its displayed price may be unavailable while phase detection continues.

### Holiday scheduling

Chinese public holidays are excluded from weekday PEAK scheduling. Weekends remain OFF-PEAK, including make-up work weekends. If required holiday-calendar coverage is missing, automatic scheduling fails closed.

### Account balance

When DSH credentials are available, PriceFlow can request balance data from DeepSeek's official balance endpoint. Balance failures do not affect pricing, phase detection, or queue scheduling.

## Privacy and local data

Queued delayed text and related queue metadata, including the target session ID, are stored locally so the queue can survive restarts. The default queue file is `%DSH_HOME%\\priceflow\\queue.json`.

The balance API key is resolved and used on the Host side; PriceFlow does not send the raw key to the Client. Balance values are held in memory and are not intentionally persisted or logged by PriceFlow. PriceFlow does not add its own telemetry.

## Official sources

- [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [DeepSeek Chinese pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- [DeepSeek balance endpoint](https://api-docs.deepseek.com/api/get-user-balance)

## Limitations

- Compatibility is intentionally limited to the independently verified DSH versions `0.2.0-rc.1` and `0.2.0-rc.2`.
- Delayed queue sends support text only; attachments are not supported.
- Automatic scheduling requires a verified pricing policy.
- Missing holiday-calendar coverage may intentionally disable automatic scheduling.
- Queue delivery is at-least-once; there is no general exactly-once guarantee.

## Development

```sh
npm test
npm run check
npm run verify
```

## License

MIT. See [LICENSE](LICENSE).
