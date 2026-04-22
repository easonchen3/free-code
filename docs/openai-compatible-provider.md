# OpenAI-Compatible Provider 使用说明

本文档用于说明如何在 `free-code` 中启用并配置 `openaiCompatible`
provider，以接入兼容 OpenAI Chat Completions API 的模型服务。

本能力适用于以下场景：

- 接入第三方 OpenAI-compatible 云服务
- 接入私有部署或网关转发的兼容接口
- 在不修改现有 Codex 路径的前提下，为项目新增可配置的大模型入口

## 一、能力概览

`openaiCompatible` 是本项目新增的独立 provider，设计目标如下：

- 不侵入原有 Codex / OpenAI 逻辑
- 使用额外配置显式启用
- 兼容 OpenAI 标准 Chat Completions 请求格式
- 支持通过 JSON 配置文件或环境变量配置模型接口

内部调用链路如下：

1. 项目内部继续以 Anthropic 风格 `messages` 发起请求
2. `openai-fetch-adapter` 将请求转换为 OpenAI Chat Completions 格式
3. 请求发送至兼容接口
4. 返回结果再转换回项目内部格式供 CLI / TUI 使用

## 二、配置项说明

推荐使用以下 provider 专用配置：

- `CLAUDE_CODE_USE_OPENAI_COMPATIBLE=1`
- `OPENAI_COMPATIBLE_API_KEY`
- `OPENAI_COMPATIBLE_BASE_URL`
- `OPENAI_COMPATIBLE_MODEL`

可选配置：

- `OPENAI_COMPATIBLE_ORGANIZATION`
- `OPENAI_COMPATIBLE_PROJECT`
- `OPENAI_COMPATIBLE_CUSTOM_HEADERS`
- `OPENAI_COMPATIBLE_THINKING_TYPE`
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS`

同时兼容以下标准命名回退：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `OPENAI_ORGANIZATION`
- `OPENAI_PROJECT`
- `OPENAI_CUSTOM_HEADERS`
- `OPENAI_THINKING_TYPE`

### 2.1 `OPENAI_COMPATIBLE_BASE_URL` 的填写方式

支持两种写法：

- 基础路径：`https://your-host/v1`
- 完整路径：`https://your-host/v1/chat/completions`

适配器会自动处理并最终请求到正确的 `/chat/completions` 路径。

### 2.2 thinking / think 配置

如果模型服务支持 thinking 参数，可通过以下配置控制：

- `OPENAI_COMPATIBLE_THINKING_TYPE=enabled`
- `OPENAI_COMPATIBLE_THINKING_TYPE=disabled`

等价的标准回退变量：

- `OPENAI_THINKING_TYPE`

当前支持值：

- `enabled`
- `disabled`

当该配置生效时，适配器会自动把它转换为请求体中的：

```json
{
  "thinking": {
    "type": "enabled"
  }
}
```

这与很多 OpenAI SDK 中通过
`extra_body={"thinking":{"type":"enabled"}}`
传入的效果一致。

## 三、配置文件位置与推荐用法

本项目支持三层配置来源，不仅限于当前项目目录下的 `.claude`。

### 3.1 用户全局配置

默认位置：

- `~/.claude/settings.json`

如果设置了环境变量 `CLAUDE_CONFIG_DIR`，则用户配置目录会切换为：

- `${CLAUDE_CONFIG_DIR}/settings.json`

适合存放：

- 个人通用默认模型
- 个人 API Key
- 跨项目复用的 provider 配置

### 3.2 项目共享配置

当前项目目录下：

- `.claude/settings.json`

适合存放：

- 团队共享的 provider 地址
- 团队统一使用的模型名
- 不含密钥的默认配置

### 3.3 项目本地私有配置

当前项目目录下：

- `.claude/settings.local.json`

适合存放：

- 本机使用的 API Key
- 本地覆盖的模型配置
- 不希望提交到仓库的个人配置

### 3.4 推荐实践

推荐按以下原则使用：

- 全局个人配置放 `~/.claude/settings.json`
- 项目共享配置放 `.claude/settings.json`
- 本地私有覆盖放 `.claude/settings.local.json`

仓库内提供的 JSON 模板：

- `.claude/settings.example.json`

## 四、JSON 配置示例

推荐优先使用 JSON 配置文件，便于与 CLI / TUI 统一使用。

### 4.1 基础示例

```json
{
  "model": "deepseek-chat",
  "env": {
    "CLAUDE_CODE_USE_OPENAI_COMPATIBLE": "1",
    "OPENAI_COMPATIBLE_API_KEY": "your-api-key",
    "OPENAI_COMPATIBLE_BASE_URL": "https://api.deepseek.com/chat/completions",
    "OPENAI_COMPATIBLE_MODEL": "deepseek-chat",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "256"
  }
}
```

### 4.2 启用 thinking 的示例

```json
{
  "model": "deepseek-reasoner",
  "env": {
    "CLAUDE_CODE_USE_OPENAI_COMPATIBLE": "1",
    "OPENAI_COMPATIBLE_API_KEY": "your-api-key",
    "OPENAI_COMPATIBLE_BASE_URL": "https://your-host/v1",
    "OPENAI_COMPATIBLE_MODEL": "deepseek-reasoner",
    "OPENAI_COMPATIBLE_THINKING_TYPE": "enabled",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "256"
  }
}
```

## 五、环境变量配置示例

仓库保留了模板文件：

- `.env.openai-compatible.example`

模板内容如下：

```env
CLAUDE_CODE_USE_OPENAI_COMPATIBLE=1
OPENAI_COMPATIBLE_API_KEY=
OPENAI_COMPATIBLE_BASE_URL=
OPENAI_COMPATIBLE_MODEL=
OPENAI_COMPATIBLE_THINKING_TYPE=
CLAUDE_CODE_MAX_OUTPUT_TOKENS=256
```

PowerShell 示例：

```powershell
$env:CLAUDE_CODE_USE_OPENAI_COMPATIBLE='1'
$env:OPENAI_COMPATIBLE_API_KEY='your-api-key'
$env:OPENAI_COMPATIBLE_BASE_URL='https://api.deepseek.com/chat/completions'
$env:OPENAI_COMPATIBLE_MODEL='deepseek-chat'
$env:OPENAI_COMPATIBLE_THINKING_TYPE='enabled'
$env:CLAUDE_CODE_MAX_OUTPUT_TOKENS='256'
```

## 六、快速验证方式

仓库中保留了一个快速验证脚本：

```powershell
bun run test:openai-compatible -- "Reply with exactly: smoke-ok"
```

该脚本会通过真实源码链路完成一次请求：

- `getAnthropicClient()`
- `openaiCompatible provider`
- `openai-fetch-adapter`
- 真实 OpenAI-compatible 接口

### 6.1 配置读取优先级

脚本会按以下顺序读取配置：

1. 当前进程环境变量
2. 当前项目 `.claude/settings.local.json`
3. 当前项目 `.claude/settings.json`
4. 用户全局 `~/.claude/settings.json`

### 6.2 验证输出内容

脚本会输出以下信息：

- 当前配置来源
- 接口地址
- 模型名称
- Thinking 配置
- 验证结论（通过 / 不通过）
- 停止原因
- Token 用量
- 测试提示词
- 模型返回内容

如需查看完整 JSON 返回，可执行：

```powershell
bun run test:openai-compatible -- --json --max-tokens 64 "Reply with exactly: json-ok"
```

## 七、源码方式验证

在已经配置好 `.claude/settings.local.json` 或其他配置文件后，可以直接运行源码版 CLI。

TUI 模式：

```powershell
bun run dev
```

单次调用：

```powershell
bun run dev -- -p "Hello"
```

便于排查的 JSON 模式：

```powershell
bun run dev -- --bare -p --output-format json "Reply with exactly: ok"
```

## 八、打包 CLI 验证

先执行打包：

```powershell
bun run build
```

然后运行：

TUI 模式：

```powershell
.\cli.exe
```

单次调用：

```powershell
.\cli.exe -p "Hello"
```

JSON 输出验证：

```powershell
.\cli.exe --bare -p --output-format json "Reply with exactly: ok"
```

如果输出中显示了你的自定义模型名，说明打包后的 `cli.exe`
已正确读取配置并通过 `openaiCompatible` provider 发起请求。

另外，`/status` 中会展示以下与该 provider 相关的状态：

- `API provider`
- `OpenAI-compatible base URL`
- `OpenAI-compatible thinking`

## 九、常见问题

### 9.1 模型不存在或没有权限

如果看到类似：

```text
There's an issue with the selected model (...)
```

通常表示以下情况之一：

- 模型名错误
- 模型名大小写不正确
- 当前 API Key 没有该模型权限
- 当前地域不支持该模型
- 接口地址与模型所属地域不匹配

建议先使用服务提供商官方 `curl` 示例单独验证接口可用性，再接入本项目。

### 9.2 `-p` 没有按预期返回

建议按以下顺序排查：

1. 运行 `bun run test:openai-compatible`
2. 运行 `bun run dev -- --bare -p ...`
3. 运行 `.\cli.exe --bare -p ...`

这样可以更快区分问题属于：

- provider 接入问题
- 源码 headless 路径问题
- 打包 CLI 行为问题

### 9.3 thinking 配置已设置但未生效

如果模型返回结果看起来没有启用 thinking，通常有以下几种可能：

- 当前模型本身不支持 thinking
- 服务端并未实现该扩展字段
- 网关对 `thinking` 字段进行了过滤
- 模型供应商使用了不同的扩展参数命名

建议先参考供应商文档确认该接口是否支持
`thinking: { "type": "enabled" }` 这一格式。
