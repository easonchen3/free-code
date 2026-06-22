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
