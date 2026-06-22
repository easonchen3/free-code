import { readdir, readFile } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { release as osRelease } from 'os'
import { getFsImplementation } from './fsOperations.js'
import { logError } from './log.js'

/** 运行环境平台分类；`wsl` 单独区分是因为它同时具备 Linux 和 Windows 路径特征。 */
export type Platform = 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown'

/** 当前产品正式支持的终端平台集合。 */
export const SUPPORTED_PLATFORMS: Platform[] = ['macos', 'wsl']

/**
 * 获取当前进程所在平台。
 *
 * @returns 平台分类；无法判断或检查失败时返回 `unknown`。
 */
export const getPlatform = memoize((): Platform => {
  try {
    // 1. Node 的平台字段能直接识别 macOS 和 Windows。
    if (process.platform === 'darwin') {
      return 'macos'
    }

    if (process.platform === 'win32') {
      return 'windows'
    }

    // 2. Linux 需要进一步区分普通 Linux 和 WSL。
    if (process.platform === 'linux') {
      try {
        const procVersion = getFsImplementation().readFileSync(
          '/proc/version',
          { encoding: 'utf8' },
        )
        // 3. WSL 的内核版本通常带有 Microsoft 或 WSL 标记。
        if (
          procVersion.toLowerCase().includes('microsoft') ||
          procVersion.toLowerCase().includes('wsl')
        ) {
          return 'wsl'
        }
      } catch (error) {
        // 4. `/proc/version` 不可读时记录问题，但仍按普通 Linux 继续。
        logError(error)
      }

      // 5. 没有 WSL 特征时归类为普通 Linux。
      return 'linux'
    }

    // 6. 其他 Node 平台暂不做细分。
    return 'unknown'
  } catch (error) {
    // 7. 平台探测不应影响主流程，异常时降级为 unknown。
    logError(error)
    return 'unknown'
  }
})

/**
 * 获取 WSL 主版本号。
 *
 * @returns WSL 版本号字符串；非 Linux、非 WSL 或无法判断时返回 undefined。
 */
export const getWslVersion = memoize((): string | undefined => {
  // 1. 只有 Linux 平台可能是 WSL，其他平台直接跳过文件读取。
  if (process.platform !== 'linux') {
    return undefined
  }
  try {
    // 2. 从内核版本字符串中寻找 WSL 标记。
    const procVersion = getFsImplementation().readFileSync('/proc/version', {
      encoding: 'utf8',
    })

    // 3. 新版 WSL 通常会显式写出 WSL2、WSL3 等版本号。
    const wslVersionMatch = procVersion.match(/WSL(\d+)/i)
    if (wslVersionMatch && wslVersionMatch[1]) {
      return wslVersionMatch[1]
    }

    // 4. 旧版 WSL1 常见格式只包含 Microsoft，不包含 WSL 数字。
    if (procVersion.toLowerCase().includes('microsoft')) {
      return '1'
    }

    // 5. 没有任何 WSL 特征时返回 undefined。
    return undefined
  } catch (error) {
    // 6. 探测失败不阻断主流程，只记录并返回未知。
    logError(error)
    return undefined
  }
})

/** Linux 发行版和内核信息，用于诊断和环境上报。 */
export type LinuxDistroInfo = {
  /** `/etc/os-release` 中的 ID，例如 ubuntu、debian。 */
  linuxDistroId?: string
  /** `/etc/os-release` 中的 VERSION_ID。 */
  linuxDistroVersion?: string
  /** `os.release()` 返回的内核版本。 */
  linuxKernel?: string
}

/**
 * 获取 Linux 发行版信息。
 *
 * @returns Linux 上返回发行版信息；非 Linux 平台返回 undefined。
 */
export const getLinuxDistroInfo = memoize(
  async (): Promise<LinuxDistroInfo | undefined> => {
    // 1. 非 Linux 平台没有 `/etc/os-release` 语义，直接跳过。
    if (process.platform !== 'linux') {
      return undefined
    }

    // 2. 内核版本可直接从 Node OS API 获取，发行版字段再从文件补充。
    const result: LinuxDistroInfo = {
      linuxKernel: osRelease(),
    }

    try {
      // 3. 解析 os-release 中的 ID 和 VERSION_ID，去掉可能的引号。
      const content = await readFile('/etc/os-release', 'utf8')
      for (const line of content.split('\n')) {
        const match = line.match(/^(ID|VERSION_ID)=(.*)$/)
        if (match && match[1] && match[2]) {
          const value = match[2].replace(/^"|"$/g, '')
          if (match[1] === 'ID') {
            result.linuxDistroId = value
          } else {
            result.linuxDistroVersion = value
          }
        }
      }
    } catch {
      // 4. 精简容器或特殊发行版可能没有该文件，保留已有内核信息即可。
    }

    // 5. 返回尽力收集到的 Linux 信息。
    return result
  },
)

/** 版本控制系统目录标记到展示名称的映射。 */
const VCS_MARKERS: Array<[string, string]> = [
  ['.git', 'git'],
  ['.hg', 'mercurial'],
  ['.svn', 'svn'],
  ['.p4config', 'perforce'],
  ['$tf', 'tfs'],
  ['.tfvc', 'tfs'],
  ['.jj', 'jujutsu'],
  ['.sl', 'sapling'],
]

/**
 * 检测指定目录中可见的版本控制系统。
 *
 * @param dir 要检查的目录；未传时使用当前文件系统工作目录。
 * @returns 检测到的 VCS 名称列表，去重后返回。
 */
export async function detectVcs(dir?: string): Promise<string[]> {
  // 1. 使用 Set 去重，因为环境变量和目录标记可能同时指向同一种 VCS。
  const detected = new Set<string>()

  // 2. Perforce 常通过环境变量配置，不一定有本地目录标记。
  if (process.env.P4PORT) {
    detected.add('perforce')
  }

  try {
    // 3. 读取目标目录的第一层条目，并匹配常见 VCS 标记文件或目录。
    const targetDir = dir ?? getFsImplementation().cwd()
    const entries = new Set(await readdir(targetDir))
    for (const [marker, vcs] of VCS_MARKERS) {
      if (entries.has(marker)) {
        detected.add(vcs)
      }
    }
  } catch {
    // 4. 目录不可读时返回已有检测结果，避免把环境探测变成硬错误。
  }

  // 5. 转为数组，给调用方稳定的普通数据结构。
  return [...detected]
}
