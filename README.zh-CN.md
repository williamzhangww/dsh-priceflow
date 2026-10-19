# dsh-priceflow

DeepSeek Harness 的官方价格时段显示与低谷发送调度插件。

[English](README.md)

## 功能简介

PriceFlow 在 DSH 对话输入框区域显示价格时段状态，并提供单独的低谷发送操作。它展示当前是峰价时段（PEAK）还是低谷时段（OFF-PEAK）、距离下一次切换的倒计时、DeepSeek 官方 USD 价格，以及官方中文价格页面公布的 CNY 价格。CNY 是页面展示值，不是由 USD 汇率换算所得，也不参与调度。

PEAK 期间可以将文本消息排入低谷队列。OFF-PEAK 期间，普通发送仍使用 DSH 原有发送流程。DSH 凭据可用时，PriceFlow 也可以显示 DeepSeek 账户余额。

## 环境要求

- Node.js 20 或更新版本
- DeepSeek Harness `>=0.2.0-rc.1 <0.3.0-0`（包含 prerelease）

已针对 DSH `0.2.0-rc.1` 和 `0.2.0-rc.2` 完成验证。版本范围允许后续 `0.2.x` 通过元数据兼容检查，但这些未来版本尚未逐一验证 API；Host 或 Client API 变化仍可能需要发布插件修复。

## 安装

在终端中将 npm 包添加到目标 DSH profile：

```sh
dsh plugin --profile <profile> add dsh-priceflow
```

将 `<profile>` 替换为 DSH profile 名称。声明的 DSH 版本范围上界为 `0.3.0-0`，不使用版本豁免。如果所用 DSH Desktop 版本提供应用内 Plugins 页面，可通过该页面将包安装到 Desktop profile。

## 功能说明

### 价格时段与倒计时

PriceFlow 按 DeepSeek 官方价格时段显示 PEAK、OFF-PEAK，以及距离下一次切换的时间。时段由 Host 定价引擎计算，Client 不会自行计算或切换时段。

### USD 与 CNY 价格

USD 价格来自 DeepSeek 官方价格页面；CNY 价格来自 DeepSeek 官方中文价格页面。CNY 仅用于展示，不会改变基于 USD 定价策略的调度。

### 低谷队列

PEAK 期间，PriceFlow 可以将文本排队，等待 OFF-PEAK 投递。OFF-PEAK 期间，普通发送遵循 DSH 原有流程。延迟队列只支持文本，不支持附件。队列会持久化，以便 Host 重启后恢复。投递采用持久化的至少一次（at-least-once）架构，发送 API 缺失、调用报错或响应不满足明确的 `accepted: true` 契约时会拒绝确认，队列消息会保留且不会标为 `submitted`。可重试错误采用有上限的退避和有限尝试次数。`submitted` 表示 DSH 已接受提交，不表示模型已经完成回复。投递仍是 at-least-once，而非 exactly-once；请求中断时结果可能不确定。

### 定价可信状态

PriceFlow 只读取并验证 DeepSeek 官方价格来源。刷新失败时，可以继续使用此前验证过的最近一次有效策略（Last Known Good，LKG），并显示数据过期警告。内置价格 fixture 仅供参考，不能授权调度。模型价格未知时，价格可能显示为不可用，但价格时段仍可正常判断。

### 节假日调度

中国法定节假日不按工作日 PEAK 时段调度。周末始终为 OFF-PEAK，调休工作周末也一样。缺少必要的节假日日历覆盖时，自动调度会安全关闭。

### 账户余额

DSH 凭据可用时，PriceFlow 可以请求 DeepSeek 官方余额接口。余额请求失败不会影响价格引擎、时段判断或队列调度。

## 隐私与本地数据

为了让队列在重启后恢复，待延迟发送的文本及相关队列元数据（包括目标 session ID）会保存在本地。默认队列文件为 `%DSH_HOME%\\priceflow\\queue.json`。

余额 API key 由 Host 端解析和使用；PriceFlow 不会把原始 key 发送给 Client。余额数值保存在内存中，PriceFlow 不会有意将其持久化或写入日志。PriceFlow 自身不添加遥测。

## 官方来源

- [DeepSeek 价格页面](https://api-docs.deepseek.com/quick_start/pricing/)
- [DeepSeek 中文价格页面](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- [DeepSeek 余额接口](https://api-docs.deepseek.com/api/get-user-balance)

## 限制

- 兼容范围有意限定为已分别验证的 DSH `0.2.0-rc.1` 与 `0.2.0-rc.2`。
- 延迟队列只支持文本，不支持附件。
- 自动调度需要已验证的价格策略。
- 节假日日历覆盖不足时，自动调度可能会按设计关闭。
- 队列采用至少一次投递；不保证通用的 exactly-once。

## 开发

```sh
npm test
npm run check
npm run verify
```

## 许可证

MIT，详见 [LICENSE](LICENSE)。
