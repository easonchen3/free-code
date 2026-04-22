# OpenAI-Compatible Provider 设计记录

本文档用于记录 `openaiCompatible` provider 的设计背景、实现边界、
关键文件、迁移注意事项与后续升级路标，方便后续 Agent 或维护者继续迭代。

## 1. 背景

项目原始能力主要围绕 Anthropic / Claude Code 以及已有的 Codex 路径展开。
在实际使用中，存在以下需求：

- 希望复用现有 CLI / TUI / QueryEngine 链路
- 不希望侵入式修改已有 Codex 逻辑
- 需要支持标准 OpenAI Chat Completions 风格接口
- 需要支持通过额外配置接入不同厂商和私有网关

因此本次改动采用了“新增独立 provider”的方案，而非改写原有 `openai`
provider。

## 2. 设计目标

### 2.1 目标

- 新增独立 `openaiCompatible` provider
- 使用额外配置显式启用
- 保持 CLI、TUI、headless、打包 CLI 使用路径一致
- 尽量复用项目已有 Anthropic 客户端与消息流
- 支持通过配置接入 thinking 扩展参数

### 2.2 非目标

- 不替换原有 Codex / OpenAI 路径
- 不重构 QueryEngine 主流程
- 不保证兼容所有非标准厂商私有字段
- 不在当前阶段引入厂商级 provider 细分（如 DeepSeek-only、DashScope-only）

## 3. 总体方案

整体方案如下：

1. 在 provider 选择层增加 `openaiCompatible`
2. 在 `getAnthropicClient()` 分流中为该 provider 构造自定义 fetch
3. 通过 `openai-fetch-adapter` 将内部 Anthropic 风格请求转换为
   OpenAI Chat Completions 请求
4. 将返回的非流式 / 流式结果再转换回项目内部 Anthropic 风格响应

设计优势：

- 对 QueryEngine 和大部分上层逻辑透明
- 最小化变更面
- 与已有 CLI / TUI 集成成本低

## 4. 关键实现文件

### 4.1 provider 与模型分流

- `src/utils/model/providers.ts`
- `src/services/api/client.ts`
- `src/utils/model/model.ts`
- `src/utils/model/validateModel.ts`
- `src/utils/model/configs.ts`
- `src/utils/model/deprecation.ts`

职责：

- 注册 `openaiCompatible` provider
- 在 provider 选择时识别 `CLAUDE_CODE_USE_OPENAI_COMPATIBLE`
- 允许自定义模型名绕过现有 allowlist
- 让模型解析、校验、配置系统可识别该 provider

### 4.2 OpenAI-compatible 请求适配

- `src/services/api/openai-fetch-adapter.ts`

职责：

- 解析 `OPENAI_COMPATIBLE_*` / `OPENAI_*` 配置
- 构造 OpenAI Chat Completions 请求地址
- 把内部 Anthropic messages 转换成 OpenAI `messages`
- 适配 tool use / tool result
- 适配非流式和 SSE 流式响应
- 处理 `thinking` 配置映射

### 4.3 配置透传与环境治理

- `src/utils/managedEnvConstants.ts`
- `src/utils/subprocessEnv.ts`
- `src/utils/swarm/spawnUtils.ts`
- `src/utils/auth.ts`
- `src/utils/apiPreconnect.ts`
- `src/services/analytics/config.ts`
- `src/utils/log.ts`

职责：

- 把新增配置纳入安全环境变量 / provider 管理变量集合
- 控制子进程和 teammate 的环境传递
- 让状态、日志、鉴权判断正确识别 3P provider

### 4.4 状态与可观测性

- `src/utils/status.tsx`
- `scripts/test-openai-compatible.ts`
- `docs/openai-compatible-provider.md`

职责：

- 在 `/status` 中显示 provider 基本状态
- 快速验证真实调用链
- 对用户提供官方说明文档

## 5. 配置优先级

当前设计中，配置来源遵循项目既有设置体系。

### 5.1 常规 CLI / TUI 运行时

配置优先级依赖项目现有 settings merge 逻辑，主要来源包括：

1. 用户全局配置 `~/.claude/settings.json`
2. 项目共享配置 `.claude/settings.json`
3. 项目本地配置 `.claude/settings.local.json`
4. `--settings` 传入的 flag settings
5. 当前进程环境变量

### 5.2 快速验证脚本

`scripts/test-openai-compatible.ts` 的读取顺序为：

1. 当前进程环境变量
2. 当前项目 `.claude/settings.local.json`
3. 当前项目 `.claude/settings.json`
4. 用户全局 `~/.claude/settings.json`

这是为了提高验证稳定性与可理解性。

## 6. thinking 设计

部分 OpenAI-compatible 服务要求通过额外字段传入 thinking 配置，例如：

```json
{
  "thinking": {
    "type": "enabled"
  }
}
```

本次实现引入以下配置项：

- `OPENAI_COMPATIBLE_THINKING_TYPE`
- `OPENAI_THINKING_TYPE`

当前支持值：

- `enabled`
- `disabled`

适配器在构造 OpenAI Chat Completions 请求体时，若检测到该配置，
会自动附加：

```json
{
  "thinking": {
    "type": "<configured-value>"
  }
}
```

说明：

- 当前实现仅支持最常见的 `type` 开关
- 未实现更复杂的 thinking 参数结构透传
- 若后续接入厂商存在更多扩展字段，建议新增一个更通用的
  `OPENAI_COMPATIBLE_EXTRA_BODY_JSON` 机制，而不是继续堆单个字段

## 7. `/status` 展示设计

当前 `openaiCompatible` provider 在 `/status` 中展示：

- `API provider`
- `OpenAI-compatible base URL`
- `OpenAI-compatible thinking`

其中 `OpenAI-compatible thinking` 的含义为：

- `Enabled`：显式配置为 `enabled`
- `Disabled`：显式配置为 `disabled`
- `Not configured`：未配置，由服务端默认行为决定

## 8. 迁移与升级注意事项

后续迁移或升级时，优先关注以下几类风险。

### 8.1 OpenAI API 兼容面变化

若 OpenAI Chat Completions 请求或流式响应结构发生变化，需要重点检查：

- `translateMessages`
- `translateTools`
- `translateToOpenAIChatCompletionsBody`
- `translateOpenAIResponseToAnthropicResponse`
- `translateOpenAIStreamToAnthropic`

### 8.2 厂商私有扩展字段增长

当前仅内建了 thinking 这一额外字段。如果后续接入更多私有能力，例如：

- reasoning 开关
- search 开关
- web grounding
- 厂商自定义 tool schema

建议采用以下策略：

1. 优先抽象成可复用的 provider 级配置
2. 若结构复杂，使用 JSON 透传而非继续新增大量单个 env
3. 保持现有 `openaiCompatible` 语义通用，不为某一家厂商硬编码

### 8.3 状态与安全配置遗漏

每次新增 `OPENAI_COMPATIBLE_*` 配置时，都需要同步检查这些位置：

- `src/utils/managedEnvConstants.ts`
- `src/utils/subprocessEnv.ts`
- `src/utils/swarm/spawnUtils.ts`
- `src/utils/model/providers.ts`
- `src/utils/status.tsx`
- `docs/openai-compatible-provider.md`
- `.claude/settings.example.json`
- `.env.openai-compatible.example`

### 8.4 模型校验与 allowlist

本 provider 的核心价值之一是支持自定义模型名，因此升级时需避免：

- 恢复对 `openaiCompatible` 模型名的强 allowlist 校验
- 在模型解析链路中误套用 first-party 假设

重点关注文件：

- `src/utils/model/model.ts`
- `src/utils/model/validateModel.ts`

## 9. 验证基线

当前建议的验证顺序：

1. 快速验证 provider 链路

```powershell
bun run test:openai-compatible -- "Reply with exactly: smoke-ok"
```

2. 验证源码 headless 链路

```powershell
bun run dev -- --bare -p --output-format json "Reply with exactly: ok"
```

3. 验证打包 CLI

```powershell
.\cli.exe --bare -p --output-format json "Reply with exactly: ok"
```

4. 检查 `/status`

确认至少能看到：

- provider 类型
- base URL
- thinking 状态

## 10. 后续可选优化

以下为后续可选演进方向：

### 10.1 更通用的扩展字段透传

可考虑新增：

- `OPENAI_COMPATIBLE_EXTRA_BODY_JSON`

用于直接合并到 Chat Completions 请求体，以支持更多厂商私有参数。

### 10.2 更细粒度的厂商兼容层

如果后续接入的厂商差异显著，可考虑在 `openaiCompatible`
之上增加厂商 presets，但不建议回到写死 URL 的方式。

### 10.3 更丰富的状态展示

可继续在 `/status` 中增加：

- 当前模型名
- 是否配置自定义 headers
- 当前配置来源（全局 / 项目 / 本地）

## 11. 维护结论

本 feature 当前的核心边界可以概括为：

- `openaiCompatible` 是一个通用、独立、非侵入式的 provider
- 其核心价值在于“保持上层 Anthropic 风格调用不变，底层转发到
  OpenAI-compatible 接口”
- 后续升级时，应优先保持通用性、透明性与配置可迁移性

如需继续扩展，请优先遵循本文档中的检查清单与文件同步规则。
