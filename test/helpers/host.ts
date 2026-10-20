/**
 * 测试工具：临时宿主树。
 *
 * 每个测试用例都建一个真的磁盘目录树并写入真的文件，
 * 而不是 mock fs —— 因为本项目的 bug 全都在「真实文件系统的边界行为」上
 * （原子写、备份、CRLF、权限）。mock 掉就测不到。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAiBase } from "../../src/host/targets.js";

export interface FakeHost {
  readonly root: string;
  readonly aiBase: string;
  readonly dshHome: string;
  cleanup(): void;
  /** 写入宿主包文件，返回绝对路径。 */
  write(relPath: string, content: string): string;
  read(relPath: string): string;
  exists(relPath: string): boolean;
  /** 生成一个看起来像真宿主的 aiBase（含一个 dsh-* 包，满足 isAiBase）。 */
}

/**
 * 建一个假的 DSH 宿主树：
 *   <root>/dsh/node_modules/@deepseek-ai/<pkg>/...
 *   <root>/dsh-home/
 */
export function makeFakeHost(seedPackages: readonly string[] = ["dsh-agent-instructions"]): FakeHost {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-test-"));
  const aiBase = path.join(root, "dsh", "node_modules", "@deepseek-ai");
  const dshHome = path.join(root, "dsh-home");
  fs.mkdirSync(aiBase, { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });
  for (const pkg of seedPackages) {
    fs.mkdirSync(path.join(aiBase, pkg), { recursive: true });
  }

  const abs = (rel: string): string => path.join(aiBase, ...rel.split("/"));

  return {
    root,
    aiBase,
    dshHome,
    cleanup(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
    write(relPath: string, content: string): string {
      const fp = abs(relPath);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content, "utf8");
      return fp;
    },
    read(relPath: string): string {
      return fs.readFileSync(abs(relPath), "utf8");
    },
    exists(relPath: string): boolean {
      return fs.existsSync(abs(relPath));
    },
  };
}

/** 断言 aiBase 被识别。 */
export function assertIsAiBase(aiBase: string): void {
  if (!isAiBase(aiBase)) throw new Error(`not recognized as aiBase: ${aiBase}`);
}
