# src/utils/platform.ts 黑盒端到端测试说明

本文档验证平台探测、Linux/WSL 信息读取和 VCS marker 检测的可观察行为。

## 1. 验证目标

- `getPlatform()` 返回受支持的枚举值之一。
- `getWslVersion()` 在非 Linux 或非 WSL 时返回 undefined，不抛异常。
- `getLinuxDistroInfo()` 在非 Linux 返回 undefined，在 Linux 返回对象。
- `detectVcs()` 能识别目录中的 VCS marker。
- `P4PORT` 环境变量能触发 Perforce 检测。

## 2. 执行脚本

```powershell
cd D:\Code\free-code
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-platform-utils-e2e"
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$env:FREE_CODE_E2E_ROOT\git-project\.git","$env:FREE_CODE_E2E_ROOT\plain" | Out-Null

$Script = @'
import {
  SUPPORTED_PLATFORMS,
  detectVcs,
  getLinuxDistroInfo,
  getPlatform,
  getWslVersion,
} from "D:/Code/free-code/src/utils/platform.ts";

const root = "D:/tmp/free-code-platform-utils-e2e";
const platform = getPlatform();
const wsl = getWslVersion();
const linux = await getLinuxDistroInfo();

const vcsGit = await detectVcs(`${root}/git-project`);
const vcsPlain = await detectVcs(`${root}/plain`);
process.env.P4PORT = "perforce:1666";
const vcsP4 = await detectVcs(`${root}/plain`);

const checks = [
  { name: "platform-enum", passed: ["macos","windows","wsl","linux","unknown"].includes(platform), platform },
  { name: "supported-array", passed: SUPPORTED_PLATFORMS.includes("macos") },
  { name: "wsl-safe", passed: wsl === undefined || /^[0-9]+$/.test(wsl), wsl },
  { name: "linux-info-safe", passed: process.platform === "linux" ? !!linux?.linuxKernel : linux === undefined },
  { name: "detect-git", passed: vcsGit.includes("git"), vcsGit },
  { name: "detect-plain", passed: vcsPlain.length === 0, vcsPlain },
  { name: "detect-perforce-env", passed: vcsP4.includes("perforce"), vcsP4 },
];

console.log(JSON.stringify(checks, null, 2));
if (checks.some(c => !c.passed)) process.exit(1);
'@
Set-Content -Path "$env:FREE_CODE_E2E_ROOT\verify.ts" -Value $Script -Encoding UTF8
bun run "$env:FREE_CODE_E2E_ROOT\verify.ts" | Tee-Object "$env:FREE_CODE_E2E_ROOT\result.json"
```

验收标准：所有 `passed` 为 `true`。

## 3. 人工复核与不可自动化边界

本文件存在天然跨平台分支。自动脚本只能验证当前机器所在平台的真实结果，并对其它平台做安全降级检查；Windows、Linux、WSL 的完整结果需要分别在对应环境人工执行。

### 3.1 当前 Windows 环境复核

人工操作：

1. 执行第 2 节脚本，生成 `result.json`。
2. 打开 `D:\tmp\free-code-platform-utils-e2e\result.json`。
3. 在 Windows PowerShell 中确认：
   - `platform-enum.platform` 通常为 `windows`。
   - `wsl-safe.wsl` 为 `undefined`。
   - `linux-info-safe` 通过且 Linux 信息为空。
   - `.git` 目录能触发 `detect-git`。
   - `P4PORT` 能触发 `detect-perforce-env`。

### 3.2 WSL 环境复核

人工操作：

1. 在 WSL 终端进入同一仓库或复制仓库到 WSL 文件系统。
2. 执行等价命令：

   ```bash
   cd /mnt/d/Code/free-code
   export FREE_CODE_E2E_ROOT=/tmp/free-code-platform-utils-e2e
   rm -rf "$FREE_CODE_E2E_ROOT"
   mkdir -p "$FREE_CODE_E2E_ROOT/git-project/.git" "$FREE_CODE_E2E_ROOT/plain"
   bun run "$FREE_CODE_E2E_ROOT/verify.ts"
   ```

3. 如果路径不同，需要把脚本中的 `D:/Code/free-code` 改成 WSL 可访问路径。
4. 检查 `getPlatform()` 是否返回 `wsl`，`getWslVersion()` 是否返回数字字符串。

通过标准：

- WSL 中 `platform-enum.platform` 为 `wsl`。
- `wsl-safe.wsl` 是纯数字字符串。
- Linux 发行版信息包含内核版本。

### 3.3 原生 Linux/macOS 复核

人工操作：

1. 在原生 Linux 或 macOS 上执行同一脚本。
2. Linux 上确认 `getLinuxDistroInfo()` 返回发行版 ID、版本号和内核版本。
3. macOS 上确认 `getPlatform()` 返回 `macos`，Linux 发行版信息为空。
4. 分别创建 `.hg`、`.svn`、`.jj` 等目录标记，补充检查 `detectVcs()`：

   ```bash
   mkdir -p "$FREE_CODE_E2E_ROOT/hg-project/.hg"
   mkdir -p "$FREE_CODE_E2E_ROOT/svn-project/.svn"
   mkdir -p "$FREE_CODE_E2E_ROOT/jj-project/.jj"
   ```

通过标准：

- 当前平台分类正确。
- 非当前平台专属函数安全返回 `undefined`，不抛异常。
- VCS 标记检测和环境变量检测都能给出预期名称。

不可自动化边界：

- 单台 Windows 机器无法真实验证原生 Linux、macOS 和 WSL 分支；必须在对应系统中执行并保存 `result.json`。
- `/proc/version`、`/etc/os-release` 内容由系统发行版决定，文档只要求字段存在和格式合理，不要求固定字符串。
