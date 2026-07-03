import { feature } from 'bun:bundle';
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import { copyFile, stat as fsStat, truncate as fsTruncate, link } from 'fs/promises';
import * as React from 'react';
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js';
import type { AppState } from 'src/state/AppState.js';
import { z } from 'zod/v4';
import { getKairosActive } from '../../bootstrap/state.js';
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import type { SetToolJSXFn, Tool, ToolCallProgress, ValidationResult } from '../../Tool.js';
import { buildTool, type ToolDef } from '../../Tool.js';
import { backgroundExistingForegroundTask, markTaskNotified, registerForeground, spawnShellTask, unregisterForeground } from '../../tasks/LocalShellTask/LocalShellTask.js';
import type { AgentId } from '../../types/ids.js';
import type { AssistantMessage } from '../../types/message.js';
import { extractClaudeCodeHints } from '../../utils/claudeCodeHints.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { errorMessage as getErrorMessage, ShellError } from '../../utils/errors.js';
import { truncate } from '../../utils/format.js';
import { lazySchema } from '../../utils/lazySchema.js';
import { logError } from '../../utils/log.js';
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js';
import { getPlatform } from '../../utils/platform.js';
import { maybeRecordPluginHint } from '../../utils/plugins/hintRecommendation.js';
import { exec } from '../../utils/Shell.js';
import type { ExecResult } from '../../utils/ShellCommand.js';
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js';
import { semanticBoolean } from '../../utils/semanticBoolean.js';
import { semanticNumber } from '../../utils/semanticNumber.js';
import { getCachedPowerShellPath } from '../../utils/shell/powershellDetection.js';
import { EndTruncatingAccumulator } from '../../utils/stringUtils.js';
import { getTaskOutputPath } from '../../utils/task/diskOutput.js';
import { TaskOutput } from '../../utils/task/TaskOutput.js';
import { isOutputLineTruncated } from '../../utils/terminal.js';
import { buildLargeToolResultMessage, ensureToolResultsDir, generatePreview, getToolResultPath, PREVIEW_SIZE_BYTES } from '../../utils/toolResultStorage.js';
import { shouldUseSandbox } from '../BashTool/shouldUseSandbox.js';
import { BackgroundHint } from '../BashTool/UI.js';
import { buildImageToolResult, isImageOutput, resetCwdIfOutsideProject, resizeShellImageOutput, stdErrAppendShellResetMessage, stripEmptyLines } from '../BashTool/utils.js';
import { trackGitOperations } from '../shared/gitOperationTracking.js';
import { interpretCommandResult } from './commandSemantics.js';
import { powershellToolHasPermission } from './powershellPermissions.js';
import { getDefaultTimeoutMs, getMaxTimeoutMs, getPrompt } from './prompt.js';
import { hasSyncSecurityConcerns, isReadOnlyCommand, resolveToCanonical } from './readOnlyValidation.js';
import { POWERSHELL_TOOL_NAME } from './toolName.js';
import { renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, renderToolUseProgressMessage, renderToolUseQueuedMessage } from './UI.js';

/**
 * PowerShell 工具执行模块。
 *
 * 该文件定义 Claude Code 的 PowerShell 工具入口，负责输入/输出 schema、权限校验、只读识别、命令执行、后台任务切换、进度上报、大输出持久化、图片输出压缩和工具结果转换。
 * 它和 BashTool 保持相近的行为边界，但需要额外处理 Windows 沙箱不可用、PowerShell 命令语义、pwsh 检测和后台任务竞态。
 */

/** 终端输出统一使用 LF；Windows 的 CRLF 会破坏 Ink 渲染布局。 */
const EOL = '\n';

/**
 * 可折叠展示的 PowerShell 搜索类命令集合。
 *
 * 命令名统一保存为小写规范名，供 UI 判断搜索输出是否可以默认折叠。
 */
const PS_SEARCH_COMMANDS = new Set(['select-string',
// grep 语义的 PowerShell 搜索命令。
'get-childitem',
// 递归文件枚举时等价于 find。
'findstr',
// Windows 原生文本搜索命令。
'where.exe' // Windows 原生 which/where 查询命令。
]);

/**
 * 可折叠展示的 PowerShell 读取/查看类命令集合。
 *
 * 这些命令通常只读取文件、路径、进程或系统信息，UI 可以把输出按“查看结果”处理。
 */
const PS_READ_COMMANDS = new Set(['get-content',
// cat 语义的文件内容读取。
'get-item',
// 文件或路径元信息读取。
'test-path',
// 等价于测试路径是否存在。
'resolve-path',
// 等价于解析真实路径。
'get-process',
// 等价于查看进程列表。
'get-service',
// 查看系统服务信息。
'get-childitem',
// ls/dir 语义；带递归时也可能被视为搜索。
'get-location',
// pwd 语义的当前位置读取。
'get-filehash',
// 读取文件校验值。
'get-acl',
// 读取权限信息。
'format-hex' // 十六进制查看文件内容。
]);

/**
 * 不改变搜索/读取语义的 PowerShell 包装命令集合。
 *
 * 这些命令只是输出包装，不应让一条读取管道被误判为写操作。
 */
const PS_SEMANTIC_NEUTRAL_COMMANDS = new Set(['write-output',
// echo 语义的输出包装。
'write-host']);

/**
 * 判断 PowerShell 命令是否属于搜索或读取类操作。
 *
 * @param command 待分类的 PowerShell 命令文本。
 * @returns 搜索和读取两个布尔标记，用于 UI 决定是否折叠展示。
 */
function isSearchOrReadPowerShellCommand(command: string): {
  isSearch: boolean;
  isRead: boolean;
} {
  // 1. 空命令没有可分类的操作，直接返回非搜索、非读取。
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      isSearch: false,
      isRead: false
    };
  }

  // 2. 同步路径无法使用完整 AST，因此只按语句分隔符和管道做轻量拆分。
  const parts = trimmed.split(/\s*[;|]\s*/).filter(Boolean);
  if (parts.length === 0) {
    return {
      isSearch: false,
      isRead: false
    };
  }
  // 3. 逐段提取首个命令名，并解析别名后的规范名。
  let hasSearch = false;
  let hasRead = false;
  let hasNonNeutralCommand = false;
  for (const part of parts) {
    const baseCommand = part.trim().split(/\s+/)[0];
    if (!baseCommand) {
      continue;
    }
    const canonical = resolveToCanonical(baseCommand);
    // 4. 输出类包装命令不改变整体语义，跳过后继续看后续命令。
    if (PS_SEMANTIC_NEUTRAL_COMMANDS.has(canonical)) {
      continue;
    }
    hasNonNeutralCommand = true;
    // 5. 只要出现非搜索/读取命令，整体就不能按可折叠的读类命令处理。
    const isPartSearch = PS_SEARCH_COMMANDS.has(canonical);
    const isPartRead = PS_READ_COMMANDS.has(canonical);
    if (!isPartSearch && !isPartRead) {
      return {
        isSearch: false,
        isRead: false
      };
    }
    if (isPartSearch) hasSearch = true;
    if (isPartRead) hasRead = true;
  }
  // 6. 全部都是语义中性输出命令时，不把它归为搜索或读取。
  if (!hasNonNeutralCommand) {
    return {
      isSearch: false,
      isRead: false
    };
  }
  return {
    isSearch: hasSearch,
    isRead: hasRead
  };
}

/** 首次显示进度提示的延迟，单位毫秒。 */
const PROGRESS_THRESHOLD_MS = 2000;
/** 进度刷新间隔，单位毫秒。 */
const PROGRESS_INTERVAL_MS = 1000;
/** assistant 模式下主线程阻塞命令自动转后台的预算，单位毫秒。 */
const ASSISTANT_BLOCKING_BUDGET_MS = 15_000;

/** 不允许自动转后台的命令规范名集合；sleep 是 PowerShell 内置别名，因此同时列出两种写法。 */
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = ['start-sleep',
// 延迟命令默认保持前台，除非调用方显式要求后台运行。
'sleep'];

/**
 * 判断命令是否允许被系统自动转入后台。
 *
 * @param command 待检查的 PowerShell 命令。
 * @returns 命令不属于显式禁止列表时返回 true。
 */
function isAutobackgroundingAllowed(command: string): boolean {
  // 1. 自动后台只看首个命令，避免长管道中的后续参数误影响前台/后台策略。
  const firstWord = command.trim().split(/\s+/)[0];
  if (!firstWord) return true;
  // 2. 先解析别名，再与禁止自动后台的规范命令名匹配。
  const canonical = resolveToCanonical(firstWord);
  return !DISALLOWED_AUTO_BACKGROUND_COMMANDS.includes(canonical);
}

/**
 * 检测会阻塞交互体验的 PowerShell sleep 首语句。
 *
 * @param command 待检查的 PowerShell 命令。
 * @returns 命中 2 秒及以上整数秒 sleep 时返回可展示的阻塞说明，否则返回 null。
 */
export function detectBlockedSleepPattern(command: string): string | null {
  // 1. 只检查第一条语句；脚本块、子 shell 或后续管道里的 sleep 不按阻塞首语句处理。
  const first = command.trim().split(/[;|&\r\n]/)[0]?.trim() ?? '';
  // 2. 匹配 Start-Sleep/sleep 的整数秒形式，支持 `-Seconds` 的 PowerShell 缩写。
  const m = /^(?:start-sleep|sleep)(?:\s+-s(?:econds)?)?\s+(\d+)\s*$/i.exec(first);
  if (!m) return null;
  // 3. 低于 2 秒的短暂停顿通常用于节流或节奏控制，不强制后台。
  const secs = parseInt(m[1]!, 10);
  if (secs < 2) return null;

  // 4. 返回独立 sleep 或 sleep 后接命令的不同提示，方便用户理解阻塞点。
  const rest = command.trim().slice(first.length).replace(/^[\s;|&]+/, '');
  return rest ? `Start-Sleep ${secs} followed by: ${rest}` : `standalone Start-Sleep ${secs}`;
}

/**
 * Windows 原生 PowerShell 无法满足强制沙箱策略时返回的拒绝文案。
 *
 * native Windows 没有 bwrap/sandbox-exec；如果企业策略要求沙箱且禁止非沙箱命令，就必须拒绝执行而不是静默绕过。
 */
const WINDOWS_SANDBOX_POLICY_REFUSAL = 'Enterprise policy requires sandboxing, but sandboxing is not available on native Windows. Shell command execution is blocked on this platform by policy.';

/**
 * 判断当前平台和企业策略是否禁止 PowerShell 执行。
 *
 * @returns native Windows 上强制沙箱但不允许非沙箱命令时返回 true。
 */
function isWindowsSandboxPolicyViolation(): boolean {
  // 1. 只在 Windows 原生平台检查该策略；Linux/macOS/WSL2 下 pwsh 可走常规沙箱包装。
  return getPlatform() === 'windows' && SandboxManager.isSandboxEnabledInSettings() && !SandboxManager.areUnsandboxedCommandsAllowed();
}

/** 模块加载时读取的后台任务禁用开关；schema 构造需要用它决定是否暴露 run_in_background。 */
const isBackgroundTasksDisabled =
// eslint-disable-next-line custom-rules/no-process-env-top-level -- schema 必须在模块加载时决定字段集合。
isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS);

/** PowerShellTool 的完整输入 schema；即使后台任务被禁用，类型层仍保留对应字段供运行时代码处理。 */
const fullInputSchema = lazySchema(() => z.strictObject({
  command: z.string().describe('The PowerShell command to execute'),
  timeout: semanticNumber(z.number().optional()).describe(`Optional timeout in milliseconds (max ${getMaxTimeoutMs()})`),
  description: z.string().optional().describe('Clear, concise description of what this command does in active voice.'),
  run_in_background: semanticBoolean(z.boolean().optional()).describe(`Set to true to run this command in the background. Use Read to read the output later.`),
  dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()).describe('Set this to true to dangerously override sandbox mode and run commands without sandboxing.')
}));

/** 实际暴露给模型的输入 schema；后台任务禁用时会隐藏 run_in_background 字段。 */
const inputSchema = lazySchema(() => isBackgroundTasksDisabled ? fullInputSchema().omit({
  run_in_background: true
}) : fullInputSchema());
/** 运行时输入 schema 类型，供 buildTool 泛型约束使用。 */
type InputSchema = ReturnType<typeof inputSchema>;

/** PowerShellTool 输入对象类型，始终包含完整 schema 字段，便于运行时兼容隐藏字段。 */
export type PowerShellToolInput = z.infer<ReturnType<typeof fullInputSchema>>;
/** PowerShellTool 输出 schema，描述命令输出、错误、图片、大输出持久化和后台任务信息。 */
const outputSchema = lazySchema(() => z.object({
  stdout: z.string().describe('The standard output of the command'),
  stderr: z.string().describe('The standard error output of the command'),
  interrupted: z.boolean().describe('Whether the command was interrupted'),
  returnCodeInterpretation: z.string().optional().describe('Semantic interpretation for non-error exit codes with special meaning'),
  isImage: z.boolean().optional().describe('Flag to indicate if stdout contains image data'),
  persistedOutputPath: z.string().optional().describe('Path to persisted full output when too large for inline'),
  persistedOutputSize: z.number().optional().describe('Total output size in bytes when persisted'),
  backgroundTaskId: z.string().optional().describe('ID of the background task if command is running in background'),
  backgroundedByUser: z.boolean().optional().describe('True if the user manually backgrounded the command with Ctrl+B'),
  assistantAutoBackgrounded: z.boolean().optional().describe('True if the command was auto-backgrounded by the assistant-mode blocking budget')
}));
/** 输出 schema 类型，供 buildTool 泛型约束使用。 */
type OutputSchema = ReturnType<typeof outputSchema>;
/** PowerShellTool 返回给上层工具系统的结构化输出类型。 */
export type Out = z.infer<OutputSchema>;
import type { PowerShellProgress } from '../../types/tools.js';
export type { PowerShellProgress } from '../../types/tools.js';

/** 用于日志归类的常见后台/长任务命令集合，记录为命令首词而不是完整命令。 */
const COMMON_BACKGROUND_COMMANDS = ['npm', 'yarn', 'pnpm', 'node', 'python', 'python3', 'go', 'cargo', 'make', 'docker', 'terraform', 'webpack', 'vite', 'jest', 'pytest', 'curl', 'Invoke-WebRequest', 'build', 'test', 'serve', 'watch', 'dev'] as const;

/**
 * 提取命令首词用于 analytics 归类。
 *
 * @param command 原始 PowerShell 命令文本。
 * @returns 命中常见命令时返回该命令名，否则返回 `other`。
 */
function getCommandTypeForLogging(command: string): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  // 1. 日志归类只看首个 token，避免把参数、路径或文件名记录成 analytics 类别。
  const trimmed = command.trim();
  const firstWord = trimmed.split(/\s+/)[0] || '';
  // 2. 命令名大小写不敏感；命中后返回受 analytics 类型约束的字面量。
  for (const cmd of COMMON_BACKGROUND_COMMANDS) {
    if (firstWord.toLowerCase() === cmd.toLowerCase()) {
      return cmd as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
    }
  }
  return 'other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
}

/** PowerShell 工具定义，负责权限校验、执行、后台任务、进度上报和结果转换。 */
export const PowerShellTool = buildTool({
  name: POWERSHELL_TOOL_NAME,
  searchHint: 'execute Windows PowerShell commands',
  maxResultSizeChars: 30_000,
  strict: true,
  /**
   * 生成工具描述文本。
   *
   * @param input 工具输入的局部字段，可能包含用户或模型提供的 description。
   * @returns 优先返回调用方描述，否则返回默认 PowerShell 执行说明。
   */
  async description({
    description
  }: Partial<PowerShellToolInput>): Promise<string> {
    // 1. description 是模型侧摘要入口，存在时直接复用，避免重复截断命令。
    return description || 'Run PowerShell command';
  },
  /**
   * 获取 PowerShellTool 的系统提示词。
   *
   * @returns 当前平台和配置下的 PowerShell 工具提示词。
   */
  async prompt(): Promise<string> {
    // 1. 提示词由 prompt 模块集中维护，工具定义只负责转发。
    return getPrompt();
  },
  /**
   * 判断该命令是否可以和其他工具并发执行。
   *
   * @param input PowerShell 工具输入。
   * @returns 只有同步读类判断通过时才视为并发安全。
   */
  isConcurrencySafe(input: PowerShellToolInput): boolean {
    // 1. 并发安全复用只读判断；无法判断时保守返回 false。
    return this.isReadOnly?.(input) ?? false;
  },
  /**
   * 判断命令是否属于搜索或读取类命令。
   *
   * @param input 可能尚未完整解析的工具输入。
   * @returns 搜索和读取分类结果，供 UI 折叠策略使用。
   */
  isSearchOrReadCommand(input: Partial<PowerShellToolInput>): {
    isSearch: boolean;
    isRead: boolean;
  } {
    // 1. 没有 command 字段时不能分类，直接返回非搜索、非读取。
    if (!input.command) {
      return {
        isSearch: false,
        isRead: false
      };
    }
    // 2. 有 command 时交给轻量 PowerShell 命令分类器处理。
    return isSearchOrReadPowerShellCommand(input.command);
  },
  /**
   * 同步判断命令是否明显只读。
   *
   * @param input PowerShell 工具输入。
   * @returns 命令没有同步安全疑点且命中只读 allowlist 时返回 true。
   */
  isReadOnly(input: PowerShellToolInput): boolean {
    // 1. 同步接口拿不到完整 AST，先用正则启发式排除子表达式、splatting、成员调用和赋值等风险形态。
    if (hasSyncSecurityConcerns(input.command)) {
      return false;
    }
    // 2. 同步只读判断只能处理简单命令；完整管道/多语句只读放行在异步权限检查里完成。
    return isReadOnlyCommand(input.command);
  },
  /**
   * 提供自动分类器使用的命令文本。
   *
   * @param input PowerShell 工具输入。
   * @returns 原始 command 字段。
   */
  toAutoClassifierInput(input) {
    // 1. 自动分类只需要命令本身，不附带 timeout、description 等执行控制字段。
    return input.command;
  },
  /**
   * 获取当前应暴露给模型的输入 schema。
   *
   * @returns 根据后台任务开关裁剪后的输入 schema。
   */
  get inputSchema(): InputSchema {
    // 1. 每次读取时通过 lazy schema 解析，确保模块加载期配置被正确应用。
    return inputSchema();
  },
  /**
   * 获取 PowerShell 工具的结构化输出 schema。
   *
   * @returns PowerShell 命令结果的结构化输出 schema。
   */
  get outputSchema(): OutputSchema {
    // 1. 输出 schema 固定描述工具返回字段，供工具系统做结构化校验。
    return outputSchema();
  },
  /**
   * 获取展示给用户的工具名称。
   *
   * @returns 固定显示名称 `PowerShell`。
   */
  userFacingName(): string {
    // 1. 用户界面使用短名称，避免暴露内部 tool id。
    return 'PowerShell';
  },
  /**
   * 生成工具调用摘要。
   *
   * @param input 可能为空的工具输入。
   * @returns description、截断后的 command 或 null。
   */
  getToolUseSummary(input: Partial<PowerShellToolInput> | undefined): string | null {
    // 1. 没有命令时不生成摘要，避免 UI 显示误导信息。
    if (!input?.command) {
      return null;
    }
    const {
      command,
      description
    } = input;
    // 2. 调用方提供 description 时优先展示更可读的意图说明。
    if (description) {
      return description;
    }
    // 3. 否则使用截断后的命令文本，控制摘要长度。
    return truncate(command, TOOL_SUMMARY_MAX_LENGTH);
  },
  /**
   * 生成活动状态描述。
   *
   * @param input 可能为空的工具输入。
   * @returns 用于 UI 状态栏的运行中文案。
   */
  getActivityDescription(input: Partial<PowerShellToolInput> | undefined): string {
    // 1. 缺少命令时使用通用运行提示。
    if (!input?.command) {
      return 'Running command';
    }
    // 2. 优先使用 description，否则使用截断命令作为活动描述。
    const desc = input.description ?? truncate(input.command, TOOL_SUMMARY_MAX_LENGTH);
    return `Running ${desc}`;
  },
  /**
   * 判断工具是否启用。
   *
   * @returns PowerShellTool 当前总是启用，具体执行能力由后续校验决定。
   */
  isEnabled(): boolean {
    // 1. 可用性不在这里按平台关闭；缺少 pwsh 等情况在执行前返回友好错误。
    return true;
  },
  /**
   * 校验工具输入是否满足执行前置条件。
   *
   * @param input PowerShell 工具输入。
   * @returns 校验通过时返回 true；命中沙箱策略或阻塞 sleep 时返回错误信息。
   */
  async validateInput(input: PowerShellToolInput): Promise<ValidationResult> {
    // 1. 先做沙箱策略防护；call() 里还会再次检查以覆盖绕过 validateInput 的调用方。
    if (isWindowsSandboxPolicyViolation()) {
      return {
        result: false,
        message: WINDOWS_SANDBOX_POLICY_REFUSAL,
        errorCode: 11
      };
    }
    // 2. Monitor 工具开启时，阻塞型 sleep 应转后台或改用 Monitor，避免主对话长时间卡住。
    if (feature('MONITOR_TOOL') && !isBackgroundTasksDisabled && !input.run_in_background) {
      const sleepPattern = detectBlockedSleepPattern(input.command);
      if (sleepPattern !== null) {
        return {
          result: false,
          message: `Blocked: ${sleepPattern}. Run blocking commands in the background with run_in_background: true — you'll get a completion notification when done. For streaming events (watching logs, polling APIs), use the Monitor tool. If you genuinely need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.`,
          errorCode: 10
        };
      }
    }
    return {
      result: true
    };
  },
  /**
   * 执行 PowerShell 工具权限检查。
   *
   * @param input PowerShell 工具输入。
   * @param context 权限系统传入的上下文。
   * @returns 权限校验结果。
   */
  async checkPermissions(input: PowerShellToolInput, context: Parameters<Tool['checkPermissions']>[1]): Promise<PermissionResult> {
    // 1. 权限逻辑集中在 powershellPermissions，工具定义只负责传递输入和上下文。
    return await powershellToolHasPermission(input, context);
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  /**
   * 将工具输出转换成 Claude API tool_result block。
   *
   * @param output PowerShell 执行后的结构化输出。
   * @param toolUseID 当前工具调用 ID。
   * @returns 可发送给 Claude 的 tool_result block。
   */
  mapToolResultToToolResultBlockParam({
    interrupted,
    stdout,
    stderr,
    isImage,
    persistedOutputPath,
    persistedOutputSize,
    backgroundTaskId,
    backgroundedByUser,
    assistantAutoBackgrounded
  }: Out, toolUseID: string): ToolResultBlockParam {
    // 1. 图片输出优先转换成 Claude 支持的图片 block；失败时继续按文本处理。
    if (isImage) {
      const block = buildImageToolResult(stdout, toolUseID);
      if (block) return block;
    }
    // 2. 大输出已落盘时，内联内容替换为预览和可读取路径，避免塞满模型上下文。
    let processedStdout = stdout;
    if (persistedOutputPath) {
      const trimmed = stdout ? stdout.replace(/^(\s*\n)+/, '').trimEnd() : '';
      const preview = generatePreview(trimmed, PREVIEW_SIZE_BYTES);
      processedStdout = buildLargeToolResultMessage({
        filepath: persistedOutputPath,
        originalSize: persistedOutputSize ?? 0,
        isJson: false,
        preview: preview.preview,
        hasMore: preview.hasMore
      });
    } else if (stdout) {
      // 3. 普通 stdout 清理前导空行和末尾空白，保持工具结果紧凑。
      processedStdout = stdout.replace(/^(\s*\n)+/, '');
      processedStdout = processedStdout.trimEnd();
    }
    // 4. 中断信息需要合并进 stderr，确保模型能看到命令未完整结束。
    let errorMessage = stderr.trim();
    if (interrupted) {
      if (stderr) errorMessage += EOL;
      errorMessage += '<error>Command was aborted before completion</error>';
    }
    // 5. 后台任务只返回任务 ID 和输出路径，让模型后续通过读取任务输出继续跟进。
    let backgroundInfo = '';
    if (backgroundTaskId) {
      const outputPath = getTaskOutputPath(backgroundTaskId);
      if (assistantAutoBackgrounded) {
        backgroundInfo = `Command exceeded the assistant-mode blocking budget (${ASSISTANT_BLOCKING_BUDGET_MS / 1000}s) and was moved to the background with ID: ${backgroundTaskId}. It is still running — you will be notified when it completes. Output is being written to: ${outputPath}. In assistant mode, delegate long-running work to a subagent or use run_in_background to keep this conversation responsive.`;
      } else if (backgroundedByUser) {
        backgroundInfo = `Command was manually backgrounded by user with ID: ${backgroundTaskId}. Output is being written to: ${outputPath}`;
      } else {
        backgroundInfo = `Command running in background with ID: ${backgroundTaskId}. Output is being written to: ${outputPath}`;
      }
    }
    // 6. 最终只拼接非空片段，并把中断状态映射为 tool_result 的错误标记。
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [processedStdout, errorMessage, backgroundInfo].filter(Boolean).join('\n'),
      is_error: interrupted
    };
  },
  /**
   * 执行 PowerShell 命令并返回工具结果。
   *
   * @param input PowerShell 工具输入。
   * @param toolUseContext 工具运行上下文，包含中断、状态更新、UI 渲染和调用 ID。
   * @param _canUseTool 预留的权限回调，本实现不直接使用。
   * @param _parentMessage 父级 assistant 消息，本实现不直接使用。
   * @param onProgress 进度上报回调。
   * @returns 包含 stdout/stderr、图片、大输出或后台任务信息的工具结果。
   */
  async call(input: PowerShellToolInput, toolUseContext: Parameters<Tool['call']>[1], _canUseTool?: CanUseToolFn, _parentMessage?: AssistantMessage, onProgress?: ToolCallProgress<PowerShellProgress>): Promise<{
    data: Out;
  }> {
    // 1. 再次执行沙箱策略检查，覆盖直接调用 call() 而跳过 validateInput 的路径。
    if (isWindowsSandboxPolicyViolation()) {
      throw new Error(WINDOWS_SANDBOX_POLICY_REFUSAL);
    }
    const {
      abortController,
      setAppState,
      setToolJSX
    } = toolUseContext;
    const isMainThread = !toolUseContext.agentId;
    let progressCounter = 0;
    try {
      // 2. 通过 generator 统一处理命令执行、进度、后台化和最终结果。
      const commandGenerator = runPowerShellCommand({
        input,
        abortController,
        // 3. 异步 Agent 的后台 shell 任务必须注册到共享任务通道，才能在 Agent 退出时被终止。
        setAppState: toolUseContext.setAppStateForTasks ?? setAppState,
        setToolJSX,
        preventCwdChanges: !isMainThread,
        isMainThread,
        toolUseId: toolUseContext.toolUseId,
        agentId: toolUseContext.agentId
      });
      let generatorResult;
      do {
        // 4. generator 未结束时把 PowerShell 进度转换成工具进度事件。
        generatorResult = await commandGenerator.next();
        if (!generatorResult.done && onProgress) {
          const progress = generatorResult.value;
          onProgress({
            toolUseID: `ps-progress-${progressCounter++}`,
            data: {
              type: 'powershell_progress',
              output: progress.output,
              fullOutput: progress.fullOutput,
              elapsedTimeSeconds: progress.elapsedTimeSeconds,
              totalLines: progress.totalLines,
              totalBytes: progress.totalBytes,
              timeoutMs: progress.timeoutMs,
              taskId: progress.taskId
            }
          });
        }
      } while (!generatorResult.done);
      const result = generatorResult.value;

      // 5. 预检失败会伪装为 code 0 + stderr 以便友好展示，这种命令没有实际运行，不能计入 git/PR 指标。
      const isPreFlightSentinel = result.code === 0 && !result.stdout && result.stderr && !result.backgroundTaskId;
      if (!isPreFlightSentinel) {
        trackGitOperations(input.command, result.code, result.stdout);
      }

      // 6. 用户发送新消息导致的 interrupt 不抛 ShellError；超时或进程被杀仍按错误处理。
      const isInterrupt = result.interrupted && abortController.signal.reason === 'interrupt';

      // 7. 只有主线程需要检查 cwd 是否跑出项目；子 Agent 使用自己的 cwd 隔离。
      let stderrForShellReset = '';
      if (isMainThread) {
        const appState = toolUseContext.getAppState();
        if (resetCwdIfOutsideProject(appState.toolPermissionContext)) {
          stderrForShellReset = stdErrAppendShellResetMessage('');
        }
      }

      // 8. 命令已后台化时立即返回任务 ID；返回前仍要剥离 Claude Code hint，避免泄露给模型。
      if (result.backgroundTaskId) {
        const bgExtracted = extractClaudeCodeHints(result.stdout || '', input.command);
        if (isMainThread && bgExtracted.hints.length > 0) {
          for (const hint of bgExtracted.hints) maybeRecordPluginHint(hint);
        }
        return {
          data: {
            stdout: bgExtracted.stripped,
            stderr: [result.stderr || '', stderrForShellReset].filter(Boolean).join('\n'),
            interrupted: false,
            backgroundTaskId: result.backgroundTaskId,
            backgroundedByUser: result.backgroundedByUser,
            assistantAutoBackgrounded: result.assistantAutoBackgrounded
          }
        };
      }
      // 9. 普通前台结果先进入尾部截断累加器，保持与 BashTool 的输出处理一致。
      const stdoutAccumulator = new EndTruncatingAccumulator();
      const processedStdout = (result.stdout || '').trimEnd();
      stdoutAccumulator.append(processedStdout + EOL);

      // 10. 根据命令语义解释退出码，兼容 grep/findstr/robocopy 等非零但非错误的外部命令。
      const interpretation = interpretCommandResult(input.command, result.code, processedStdout, result.stderr || '');

      // 11. 清理输出空行后扫描 Claude Code hint；只有主线程记录推荐，所有路径都剥离标签。
      let stdout = stripEmptyLines(stdoutAccumulator.toString());

      const extracted = extractClaudeCodeHints(stdout, input.command);
      stdout = extracted.stripped;
      if (isMainThread && extracted.hints.length > 0) {
        for (const hint of extracted.hints) maybeRecordPluginHint(hint);
      }

      // 12. preSpawnError 表示 shell 内部启动前失败，不能按普通退出码解释。
      if (result.preSpawnError) {
        throw new Error(result.preSpawnError);
      }
      if (interpretation.isError && !isInterrupt) {
        throw new ShellError(stdout, result.stderr || '', result.code, result.interrupted);
      }

      // 13. 成功命令的大输出复制到 tool-results，失败命令不落盘，避免产生孤儿结果文件。
      const MAX_PERSISTED_SIZE = 64 * 1024 * 1024;
      let persistedOutputPath: string | undefined;
      let persistedOutputSize: number | undefined;
      if (result.outputFilePath && result.outputTaskId) {
        try {
          const fileStat = await fsStat(result.outputFilePath);
          persistedOutputSize = fileStat.size;
          await ensureToolResultsDir();
          const dest = getToolResultPath(result.outputTaskId, false);
          if (fileStat.size > MAX_PERSISTED_SIZE) {
            await fsTruncate(result.outputFilePath, MAX_PERSISTED_SIZE);
          }
          try {
            await link(result.outputFilePath, dest);
          } catch {
            await copyFile(result.outputFilePath, dest);
          }
          persistedOutputPath = dest;
        } catch {
          // 14. 输出文件可能已被清理；此时保留 stdout 预览即可。
        }
      }

      // 15. 如果 stdout 是图片数据，则限制尺寸和大小，避免 UI 或模型接收过大图片。
      let isImage = isImageOutput(stdout);
      let compressedStdout = stdout;
      if (isImage) {
        const resized = await resizeShellImageOutput(stdout, result.outputFilePath, persistedOutputSize);
        if (resized) {
          compressedStdout = resized;
        } else {
          // 16. 图片解析失败时按文本返回，并同步修正 isImage，避免 UI 错标为图片。
          isImage = false;
        }
      }
      // 17. 记录命令执行指标，并返回最终工具数据。
      const finalStderr = [result.stderr || '', stderrForShellReset].filter(Boolean).join('\n');
      logEvent('tengu_powershell_tool_command_executed', {
        command_type: getCommandTypeForLogging(input.command),
        stdout_length: compressedStdout.length,
        stderr_length: finalStderr.length,
        exit_code: result.code,
        interrupted: result.interrupted
      });
      return {
        data: {
          stdout: compressedStdout,
          stderr: finalStderr,
          interrupted: result.interrupted,
          returnCodeInterpretation: interpretation.message,
          isImage,
          persistedOutputPath,
          persistedOutputSize
        }
      };
    } finally {
      // 18. 无论成功还是抛错，都清理工具级 JSX，避免背景提示残留。
      if (setToolJSX) setToolJSX(null);
    }
  },
  /**
   * 判断工具输出是否被终端层截断。
   *
   * @param output PowerShell 工具输出。
   * @returns stdout 或 stderr 任一行被截断时返回 true。
   */
  isResultTruncated(output: Out): boolean {
    // 1. 截断状态分别检查 stdout/stderr，任一命中都需要 UI 展示截断提示。
    return isOutputLineTruncated(output.stdout) || isOutputLineTruncated(output.stderr);
  }
} satisfies ToolDef<InputSchema, Out>);

/**
 * 执行 PowerShell 命令并以 generator 形式产出进度和最终结果。
 *
 * @param input PowerShell 工具输入。
 * @param abortController 控制命令中断和用户打断的 AbortController。
 * @param setAppState 更新应用状态的回调。
 * @param setToolJSX 可选的工具 UI 更新回调。
 * @param preventCwdChanges 是否阻止命令改变当前工作目录。
 * @param isMainThread 是否来自主线程；子 Agent 会使用独立 cwd 和任务生命周期。
 * @param toolUseId 当前工具调用 ID。
 * @param agentId 子 Agent ID；主线程调用时为空。
 * @returns 异步 generator；中间产出进度，完成时返回 ExecResult。
 */
async function* runPowerShellCommand({
  input,
  abortController,
  setAppState,
  setToolJSX,
  preventCwdChanges,
  isMainThread,
  toolUseId,
  agentId
}: {
  input: PowerShellToolInput;
  abortController: AbortController;
  setAppState: (f: (prev: AppState) => AppState) => void;
  setToolJSX?: SetToolJSXFn;
  preventCwdChanges?: boolean;
  isMainThread?: boolean;
  toolUseId?: string;
  agentId?: AgentId;
}): AsyncGenerator<{
  type: 'progress';
  output: string;
  fullOutput: string;
  elapsedTimeSeconds: number;
  totalLines: number;
  totalBytes: number;
  taskId?: string;
  timeoutMs?: number;
}, ExecResult, void> {
  const {
    command,
    description,
    timeout,
    run_in_background,
    dangerouslyDisableSandbox
  } = input;
  // 1. 计算最终超时时间，并初始化进度缓存和后台任务状态。
  const timeoutMs = Math.min(timeout || getDefaultTimeoutMs(), getMaxTimeoutMs());
  let fullOutput = '';
  let lastProgressOutput = '';
  let lastTotalLines = 0;
  let lastTotalBytes = 0;
  let backgroundShellId: string | undefined = undefined;
  let interruptBackgroundingStarted = false;
  let assistantAutoBackgrounded = false;

  // 2. 该信号用于后台任务创建完成后唤醒 Promise.race，避免等到下一次定时轮询。
  let resolveProgress: (() => void) | null = null;
  /**
   * 创建一次性进度唤醒信号。
   *
   * @returns 在后台任务完成注册时 resolve 的 Promise。
   */
  function createProgressSignal(): Promise<null> {
    // 1. 保存 resolve 句柄，供异步后台注册路径主动唤醒进度循环。
    return new Promise<null>(resolve => {
      resolveProgress = () => resolve(null);
    });
  }
  // 3. 判断命令是否允许自动后台化，并解析可用的 PowerShell 可执行路径。
  const shouldAutoBackground = !isBackgroundTasksDisabled && isAutobackgroundingAllowed(command);
  const powershellPath = await getCachedPowerShellPath();
  if (!powershellPath) {
    // 4. PowerShell 不可用属于执行前失败，返回 code 0 让上层以友好 stderr 展示而不是抛 ShellError。
    return {
      stdout: '',
      stderr: 'PowerShell is not available on this system.',
      code: 0,
      interrupted: false
    };
  }
  let shellCommand: Awaited<ReturnType<typeof exec>>;
  try {
    // 5. 创建底层 shell 命令，并把输出进度同步到本地缓存。
    shellCommand = await exec(command, abortController.signal, 'powershell', {
      timeout: timeoutMs,
      /**
       * 接收底层 shell 输出进度。
       *
       * @param lastLines 最近一批输出行。
       * @param allLines 当前已收集的完整输出预览。
       * @param totalLines 当前累计输出行数。
       * @param totalBytes 当前累计输出字节数。
       * @param isIncomplete 输出是否仍在继续或已经被截断。
       * @returns 无返回值；通过闭包更新进度缓存。
       */
      onProgress(lastLines, allLines, totalLines, totalBytes, isIncomplete) {
        // 1. 缓存最新进度快照，等待 generator 下一次 tick 产出。
        lastProgressOutput = lastLines;
        fullOutput = allLines;
        lastTotalLines = totalLines;
        lastTotalBytes = isIncomplete ? totalBytes : 0;
      },
      preventCwdChanges,
      // 6. 非 Windows 平台的 pwsh 可作为普通原生命令进入沙箱；Windows 原生平台不支持该沙箱包装。
      shouldUseSandbox: getPlatform() === 'windows' ? false : shouldUseSandbox({
        command,
        dangerouslyDisableSandbox
      }),
      shouldAutoBackground
    });
  } catch (e) {
    logError(e);
    // 7. spawn/exec 在命令运行前失败，同样返回友好 stderr，避免把预检问题当作命令退出错误。
    return {
      stdout: '',
      stderr: `Failed to execute PowerShell command: ${getErrorMessage(e)}`,
      code: 0,
      interrupted: false
    };
  }
  const resultPromise = shellCommand.result;

  /**
   * 将当前 shell 命令注册为后台任务。
   *
   * @returns 后台任务 ID。
   */
  async function spawnBackgroundTask(): Promise<string> {
    // 1. 后台任务复用当前 shellCommand，确保后续可以读取输出并在 Agent 退出时清理。
    const handle = await spawnShellTask({
      command,
      description: description || command,
      shellCommand,
      toolUseId,
      agentId
    }, {
      abortController,
      getAppState: () => {
        throw new Error('getAppState not available in runPowerShellCommand context');
      },
      setAppState
    });
    return handle.taskId;
  }

  /**
   * 启动后台化流程并记录 analytics。
   *
   * @param eventName 要记录的后台化事件名。
   * @param backgroundFn 底层 shell 提供的后台化回调。
   * @returns 无返回值。
   */
  function startBackgrounding(eventName: string, backgroundFn?: (shellId: string) => void): void {
    // 1. 已注册前台任务时原地转后台，避免重复创建任务、重复事件和清理回调泄漏。
    if (foregroundTaskId) {
      if (!backgroundExistingForegroundTask(foregroundTaskId, shellCommand, description || command, setAppState, toolUseId)) {
        return;
      }
      backgroundShellId = foregroundTaskId;
      logEvent(eventName, {
        command_type: getCommandTypeForLogging(command)
      });
      backgroundFn?.(foregroundTaskId);
      return;
    }

    // 2. 尚未注册前台任务时创建新的后台任务；注册完成后写入后台任务 ID。
    void spawnBackgroundTask().then(shellId => {
      backgroundShellId = shellId;

      // 3. 主动唤醒进度循环，让 generator 立即看到 backgroundShellId。
      const resolve = resolveProgress;
      if (resolve) {
        resolveProgress = null;
        resolve();
      }
      logEvent(eventName, {
        command_type: getCommandTypeForLogging(command)
      });
      if (backgroundFn) {
        backgroundFn(shellId);
      }
    });
  }

  // 8. 底层命令超时时，如果允许自动后台化，则转后台而不是直接阻塞当前会话。
  if (shellCommand.onTimeout && shouldAutoBackground) {
    shellCommand.onTimeout(backgroundFn => {
      startBackgrounding('tengu_powershell_command_timeout_backgrounded', backgroundFn);
    });
  }

  // 9. assistant 模式下主线程超过阻塞预算后自动后台化，让对话继续响应。
  if (feature('KAIROS') && getKairosActive() && isMainThread && !isBackgroundTasksDisabled && run_in_background !== true) {
    setTimeout(() => {
      if (shellCommand.status === 'running' && backgroundShellId === undefined) {
        assistantAutoBackgrounded = true;
        startBackgrounding('tengu_powershell_command_assistant_auto_backgrounded');
      }
    }, ASSISTANT_BLOCKING_BUDGET_MS).unref();
  }

  // 10. 显式 run_in_background 优先级最高，即使命令不允许自动后台化也要尊重调用方请求。
  if (run_in_background === true && !isBackgroundTasksDisabled) {
    const shellId = await spawnBackgroundTask();
    logEvent('tengu_powershell_command_explicitly_backgrounded', {
      command_type: getCommandTypeForLogging(command)
    });
    return {
      stdout: '',
      stderr: '',
      code: 0,
      interrupted: false,
      backgroundTaskId: shellId
    };
  }

  // 11. 开始轮询任务输出文件，用于向 UI 和模型上报增量进度。
  TaskOutput.startPolling(shellCommand.taskOutput.taskId);

  // 12. 初始化进度循环的时间基准和前台任务 ID。
  const startTime = Date.now();
  let nextProgressTime = startTime + PROGRESS_THRESHOLD_MS;
  let foregroundTaskId: string | undefined = undefined;

  // 13. 用 try/finally 包住进度循环，确保正常完成、后台化、打断或异常都会停止轮询。
  try {
    while (true) {
      // 14. 同时等待命令完成、下一次进度 tick 或后台注册唤醒。
      const now = Date.now();
      const timeUntilNextProgress = Math.max(0, nextProgressTime - now);
      const progressSignal = createProgressSignal();
      const result = await Promise.race([resultPromise, new Promise<null>(resolve => setTimeout(r => r(null), timeUntilNextProgress, resolve).unref()), progressSignal]);
      if (result !== null) {
        // 15. 如果后台化和命令完成发生竞态，则还原为普通完成结果，避免模型看到已完成命令仍带后台 ID。
        if (result.backgroundTaskId !== undefined) {
          markTaskNotified(result.backgroundTaskId, setAppState);
          const fixedResult: ExecResult = {
            ...result,
            backgroundTaskId: undefined
          };
          // 16. 竞态路径会跳过大输出路径填充，这里按完成命令补回输出文件信息。
          const {
            taskOutput
          } = shellCommand;
          if (taskOutput.stdoutToFile && !taskOutput.outputFileRedundant) {
            fixedResult.outputFilePath = taskOutput.path;
            fixedResult.outputFileSize = taskOutput.outputFileSize;
            fixedResult.outputTaskId = taskOutput.taskId;
          }
          // 17. 进程已经结束，立即清理监听器；真正后台运行的任务会由 LocalShellTask 接管。
          shellCommand.cleanup();
          return fixedResult;
        }
        // 18. 命令正常完成，直接返回底层结果。
        return result;
      }

      // 19. 命令已转后台时返回后台任务结果；用户打断后台化保留已收集输出。
      if (backgroundShellId) {
        return {
          stdout: interruptBackgroundingStarted ? fullOutput : '',
          stderr: '',
          code: 0,
          interrupted: false,
          backgroundTaskId: backgroundShellId,
          assistantAutoBackgrounded
        };
      }

      // 20. 用户提交新消息时优先转后台而不是杀进程，减少长任务状态丢失。
      if (abortController.signal.aborted && abortController.signal.reason === 'interrupt' && !interruptBackgroundingStarted) {
        interruptBackgroundingStarted = true;
        if (!isBackgroundTasksDisabled) {
          startBackgrounding('tengu_powershell_command_interrupt_backgrounded');
          // 21. 重新进入循环，让同步前台转后台路径先被 backgroundShellId 分支捕获。
          continue;
        }
        shellCommand.kill();
      }

      // 22. Ctrl+B 会把已注册前台任务转后台，此时返回用户手动后台化标记。
      if (foregroundTaskId) {
        if (shellCommand.status === 'backgrounded') {
          return {
            stdout: '',
            stderr: '',
            code: 0,
            interrupted: false,
            backgroundTaskId: foregroundTaskId,
            backgroundedByUser: true
          };
        }
      }

      // 23. 计算已运行时间，并决定是否显示前台后台化提示。
      const elapsed = Date.now() - startTime;
      const elapsedSeconds = Math.floor(elapsed / 1000);

      // 24. 超过阈值后注册前台任务并展示后台化 UI 提示。
      if (!isBackgroundTasksDisabled && backgroundShellId === undefined && elapsedSeconds >= PROGRESS_THRESHOLD_MS / 1000 && setToolJSX) {
        if (!foregroundTaskId) {
          foregroundTaskId = registerForeground({
            command,
            description: description || command,
            shellCommand,
            agentId
          }, setAppState, toolUseId);
        }
        setToolJSX({
          jsx: <BackgroundHint />,
          shouldHidePromptInput: false,
          shouldContinueAnimation: true,
          showSpinner: true
        });
      }
      // 25. 向调用方产出本轮进度快照。
      yield {
        type: 'progress',
        fullOutput,
        output: lastProgressOutput,
        elapsedTimeSeconds: elapsedSeconds,
        totalLines: lastTotalLines,
        totalBytes: lastTotalBytes,
        taskId: shellCommand.taskOutput.taskId,
        ...(timeout ? {
          timeoutMs
        } : undefined)
      };
      nextProgressTime = Date.now() + PROGRESS_INTERVAL_MS;
    }
  } finally {
    // 26. 离开循环时停止输出轮询，避免文件监听继续占用资源。
    TaskOutput.stopPolling(shellCommand.taskOutput.taskId);
    // 27. 非后台任务由当前调用负责清理；已后台化任务交给 LocalShellTask 生命周期管理。
    if (!backgroundShellId && shellCommand.status !== 'backgrounded') {
      if (foregroundTaskId) {
        unregisterForeground(foregroundTaskId, setAppState);
      }
      shellCommand.cleanup();
    }
  }
}
