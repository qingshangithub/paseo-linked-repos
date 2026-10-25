import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** 隔离用户的全局 git 配置（签名、模板等），让测试在任何机器上行为一致。 */
export function isolateGit(): void {
  // 用真实的空文件而不是 /dev/null：git 偶尔会尝试写全局配置，对 /dev/null 加锁会报错
  const globalConfig = join(realpathSync(mkdtempSync(join(tmpdir(), "lr-gitcfg-"))), "config");
  writeFileSync(globalConfig, "");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_AUTHOR_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = "test@example.com";
  process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_COMMITTER_EMAIL = "test@example.com";
}

/** 在 cwd 里运行 git 并返回去掉首尾空白的输出。 */
export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** 创建临时目录并解析符号链接（macOS 的 /var 实际是 /private/var），保证与 git 输出的路径一致。 */
export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** 写文件，必要时创建上级目录。 */
export function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * 在 base 下建一个带远端的仓库：先有一个种子仓库，再克隆成 bare 的“远端”，最后克隆出工作副本，
 * 这样 origin/HEAD 指向 main，与真实使用场景一致。返回工作副本路径。
 */
export function makeRepo(base: string, name: string): string {
  const seed = join(base, `${name}-seed`);
  mkdirSync(seed, { recursive: true });
  sh(seed, "init", "-q", "-b", "main");
  write(join(seed, "README.md"), "readme\n");
  write(join(seed, "src/a.txt"), "one\ntwo\nthree\n");
  sh(seed, "add", ".");
  sh(seed, "commit", "-q", "-m", "init");
  const origin = join(base, `${name}-origin.git`);
  sh(base, "clone", "-q", "--bare", seed, origin);
  const work = join(base, name);
  sh(base, "clone", "-q", origin, work);
  return work;
}
