/**
 * prompt-state 测试（真实临时目录 + 注入时钟）。
 *
 * 重点是**高频读取的缓存语义**：先看时间窗、再看 mtime。
 * 原实现先 stat 再判缓存，而 assemble 空闲时 33ms 调一次 → 每秒 30 次白做。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HUNG_CACHE_MS,
  InjectRefreshCache,
  PromptState,
  findOverrideFile,
  hashOverride,
  normalizeOverride,
  readPromptInjectFileSync,
  statInjectMtimeMs,
} from "../../src/plugin/prompt-state.js";

function makeHome(): { home: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "w4-prompt-"));
  return {
    home,
    cleanup: (): void => {
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const BUNDLED = "BUILT-IN DEFAULT PROMPT";

describe("normalizeOverride", () => {
  it("CRLF → LF + trim", () => {
    assert.equal(normalizeOverride("  a\r\nb  "), "a\nb");
  });
  it("null/undefined → 空串", () => {
    assert.equal(normalizeOverride(null), "");
    assert.equal(normalizeOverride(undefined), "");
  });
  it("纯空白 → 空串", () => {
    assert.equal(normalizeOverride("   \n "), "");
  });
});

describe("hashOverride", () => {
  it("归一化后相同即同哈希（CRLF 不影响）", () => {
    assert.equal(hashOverride("a\r\nb"), hashOverride("a\nb"));
  });
  it("前后空白不影响", () => {
    assert.equal(hashOverride("  a  "), hashOverride("a"));
  });
  it("内容不同则哈希不同", () => {
    assert.notEqual(hashOverride("a"), hashOverride("b"));
  });
});

describe("findOverrideFile / readPromptInjectFileSync", () => {
  it("拼在 dshHome 下", () => {
    assert.equal(findOverrideFile("/home/x"), path.join("/home/x", "prompt-inject.md"));
  });

  it("文件不存在 → 空串", () => {
    const { home, cleanup } = makeHome();
    try {
      assert.equal(readPromptInjectFileSync(home), "");
    } finally {
      cleanup();
    }
  });

  it("去 BOM", () => {
    const { home, cleanup } = makeHome();
    try {
      fs.writeFileSync(path.join(home, "prompt-inject.md"), "\uFEFF正文");
      assert.equal(readPromptInjectFileSync(home), "正文");
    } finally {
      cleanup();
    }
  });

  it("保留原文换行（不归一化）", () => {
    const { home, cleanup } = makeHome();
    try {
      fs.writeFileSync(path.join(home, "prompt-inject.md"), "a\r\nb");
      assert.equal(readPromptInjectFileSync(home), "a\r\nb");
    } finally {
      cleanup();
    }
  });
});

describe("PromptState.resolve：四态", () => {
  it("磁盘有内容 → source=prompt", () => {
    const { home, cleanup } = makeHome();
    try {
      fs.writeFileSync(path.join(home, "prompt-inject.md"), "用户提示词");
      const state = new PromptState({ bundledDefault: () => BUNDLED });
      const resolved = state.resolve(home);
      assert.equal(resolved.source, "prompt");
      assert.equal(resolved.text, "用户提示词");
    } finally {
      cleanup();
    }
  });

  it("磁盘内容等于内置默认 → source=default", () => {
    const { home, cleanup } = makeHome();
    try {
      fs.writeFileSync(path.join(home, "prompt-inject.md"), BUNDLED);
      const state = new PromptState({ bundledDefault: () => BUNDLED });
      assert.equal(state.resolve(home).source, "default");
    } finally {
      cleanup();
    }
  });

  it("磁盘空 + 进程内提交 → source=prompt（并归一化 CRLF）", () => {
    const { home, cleanup } = makeHome();
    try {
      const state = new PromptState({ bundledDefault: () => BUNDLED });
      state.rememberCommitted(home, "a\r\nb");
      const resolved = state.resolve(home);
      assert.equal(resolved.source, "prompt");
      assert.equal(resolved.text, "a\nb");
    } finally {
      cleanup();
    }
  });

  it("都没有 → 内置默认", () => {
    const { home, cleanup } = makeHome();
    try {
      const state = new PromptState({ bundledDefault: () => BUNDLED });
      const resolved = state.resolve(home);
      assert.equal(resolved.source, "default");
      assert.equal(resolved.text, BUNDLED);
    } finally {
      cleanup();
    }
  });

  it("内置默认也是空 → source=none（明确的第四态）", () => {
    const { home, cleanup } = makeHome();
    try {
      const state = new PromptState({ bundledDefault: () => "" });
      const resolved = state.resolve(home);
      assert.equal(resolved.source, "none");
      assert.equal(resolved.text, "");
    } finally {
      cleanup();
    }
  });

  it("ruleId 恒为 null（规则集不参与注入链）", () => {
    const { home, cleanup } = makeHome();
    try {
      assert.equal(new PromptState().resolve(home).ruleId, null);
    } finally {
      cleanup();
    }
  });
});

describe("PromptState：进程内提交", () => {
  it("同 home 可读回", () => {
    const { home, cleanup } = makeHome();
    try {
      const state = new PromptState();
      state.rememberCommitted(home, "x");
      assert.equal(state.peekCommitted(home), "x");
    } finally {
      cleanup();
    }
  });

  it("不同 home → null（不串用上一份）", () => {
    const { home, cleanup } = makeHome();
    try {
      const state = new PromptState();
      state.rememberCommitted(home, "x");
      assert.equal(state.peekCommitted("/some/other/home"), null);
    } finally {
      cleanup();
    }
  });

  it("空 home 不记（避免写到错误位置）", () => {
    const state = new PromptState();
    state.rememberCommitted("", "x");
    assert.equal(state.peekCommitted(""), null);
  });

  it("没提交过 → null", () => {
    assert.equal(new PromptState().peekCommitted("/x"), null);
  });
});

describe("PromptState：挂上 / 保证操作者正文", () => {
  it("hang / hung 往返", () => {
    const state = new PromptState();
    state.hang("abc");
    assert.equal(state.hung(), "abc");
    state.hang(null);
    assert.equal(state.hung(), "");
  });

  it("ensureOperatorBody 会顺势 hang", () => {
    const { home, cleanup } = makeHome();
    try {
      const state = new PromptState({ bundledDefault: () => BUNDLED });
      assert.equal(state.ensureOperatorBody(home), BUNDLED);
      assert.equal(state.hung(), BUNDLED);
    } finally {
      cleanup();
    }
  });

  it("什么都拿不到时退回已挂的正文", () => {
    const { home, cleanup } = makeHome();
    try {
      const state = new PromptState({ bundledDefault: () => "" });
      state.hang("先前挂上的");
      assert.equal(state.ensureOperatorBody(home), "先前挂上的");
    } finally {
      cleanup();
    }
  });

  it("完全空 → 空串", () => {
    const { home, cleanup } = makeHome();
    try {
      assert.equal(new PromptState({ bundledDefault: () => "" }).ensureOperatorBody(home), "");
    } finally {
      cleanup();
    }
  });
});

describe("InjectRefreshCache：缓存语义", () => {
  it("窗口内不 stat（第二次调用零 stat）", () => {
    const { home, cleanup } = makeHome();
    try {
      let now = 1000;
      const state = new PromptState({ bundledDefault: () => BUNDLED });
      const cache = new InjectRefreshCache({ state, now: () => now });
      cache.refresh(home);
      const afterFirst = cache.statCalls();
      now += HUNG_CACHE_MS - 1;
      cache.refresh(home);
      assert.equal(cache.statCalls(), afterFirst, "窗口内不该再 stat");
    } finally {
      cleanup();
    }
  });

  it("窗口外会重新 stat", () => {
    const { home, cleanup } = makeHome();
    try {
      let now = 1000;
      const cache = new InjectRefreshCache({
        state: new PromptState({ bundledDefault: () => BUNDLED }),
        now: () => now,
      });
      cache.refresh(home);
      const afterFirst = cache.statCalls();
      now += HUNG_CACHE_MS + 1;
      cache.refresh(home);
      assert.equal(cache.statCalls() > afterFirst, true, "窗口外必须重新确认磁盘");
    } finally {
      cleanup();
    }
  });

  it("mtime 未变 → 复用结果", () => {
    const { home, cleanup } = makeHome();
    try {
      let now = 1000;
      let statCount = 0;
      const state = new PromptState({ bundledDefault: () => BUNDLED });
      const cache = new InjectRefreshCache({
        state,
        now: () => now,
        statMtime: () => {
          statCount += 1;
          return 42;
        },
      });
      cache.refresh(home);
      const firstStat = statCount;
      now += HUNG_CACHE_MS + 1;
      const second = cache.refresh(home);
      assert.equal(second.text, BUNDLED);
      assert.equal(statCount > firstStat, true);
    } finally {
      cleanup();
    }
  });

  it("home 变化时缓存失效", () => {
    const { home, cleanup } = makeHome();
    try {
      const cache = new InjectRefreshCache({
        state: new PromptState({ bundledDefault: () => BUNDLED }),
        statMtime: () => 1,
      });
      cache.refresh(home);
      cache.refresh("/different/home");
      assert.equal(cache.statCalls() >= 2, true);
    } finally {
      cleanup();
    }
  });

  it("命中时把正文挂上并记住（下一轮还能读到）", () => {
    const { home, cleanup } = makeHome();
    try {
      const state = new PromptState({ bundledDefault: () => BUNDLED });
      const cache = new InjectRefreshCache({ state });
      cache.refresh(home);
      assert.equal(state.hung(), BUNDLED);
      assert.equal(state.peekCommitted(home), BUNDLED);
    } finally {
      cleanup();
    }
  });

  it("磁盘改了内容，窗口外能读到新值", () => {
    const { home, cleanup } = makeHome();
    try {
      let now = 1000;
      const state = new PromptState({ bundledDefault: () => "" });
      const cache = new InjectRefreshCache({ state, now: () => now });
      const first = cache.refresh(home);
      assert.equal(first.text, "");
      fs.writeFileSync(path.join(home, "prompt-inject.md"), "新提示词");
      // 保证 mtime 有变化
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(home, "prompt-inject.md"), future, future);
      now += HUNG_CACHE_MS + 1;
      const second = cache.refresh(home);
      assert.equal(second.text, "新提示词");
    } finally {
      cleanup();
    }
  });

  it("reset 之后重新 stat", () => {
    const { home, cleanup } = makeHome();
    try {
      const cache = new InjectRefreshCache({
        state: new PromptState({ bundledDefault: () => BUNDLED }),
        statMtime: () => 7,
      });
      cache.refresh(home);
      const before = cache.statCalls();
      cache.reset();
      cache.refresh(home);
      assert.equal(cache.statCalls() > before, true);
    } finally {
      cleanup();
    }
  });
});

describe("statInjectMtimeMs", () => {
  it("空 home → 0", () => {
    assert.equal(statInjectMtimeMs(""), 0);
  });

  it("文件不存在 → 0", () => {
    const { home, cleanup } = makeHome();
    try {
      assert.equal(statInjectMtimeMs(home), 0);
    } finally {
      cleanup();
    }
  });

  it("存在时返回整数毫秒", () => {
    const { home, cleanup } = makeHome();
    try {
      fs.writeFileSync(path.join(home, "prompt-inject.md"), "x");
      const mtime = statInjectMtimeMs(home);
      assert.equal(mtime > 0, true);
      assert.equal(Number.isInteger(mtime), true);
    } finally {
      cleanup();
    }
  });
});
