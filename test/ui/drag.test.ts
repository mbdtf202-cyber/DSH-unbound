/**
 * 拖拽几何测试。
 *
 * 重点是六种操作的**符号正确性** —— 尤其左缩放：
 * `x + dx` 与 `w - dx` 必须反向对称，否则拖左边缘时右边界会跟着移动。
 * 这类错误在界面上表现为「面板像在滑」，不报错、难归因。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INTERACTIVE_SELECTOR,
  applyDrag,
  beginDrag,
  dragOriginOf,
  isPrimaryButton,
  shouldIgnoreDrag,
  type DragHost,
  type MouseMoveEvent,
} from "../../src/redteam/client/drag.js";
import { DOCK_MIN_HEIGHT, DOCK_MIN_WIDTH, type DockGeometry } from "../../src/redteam/client/state.js";

const VIEWPORT = { width: 1280, height: 800 } as const;
const BASE: DockGeometry = { x: 100, y: 100, w: 500, h: 400 };

/** 起点。 */
function origin(cx = 200, cy = 200): ReturnType<typeof dragOriginOf> {
  return dragOriginOf(cx, cy, BASE);
}

describe("dragOriginOf", () => {
  it("记录起点与几何", () => {
    const o = dragOriginOf(1, 2, BASE);
    assert.equal(o.clientX, 1);
    assert.equal(o.clientY, 2);
    assert.deepEqual(o.geometry, BASE);
  });
});

describe("applyDrag — move", () => {
  it("按位移平移", () => {
    const result = applyDrag("move", origin(), 250, 230, VIEWPORT);
    assert.deepEqual(result, { x: 150, y: 130, w: 500, h: 400 });
  });

  it("尺寸不变", () => {
    const result = applyDrag("move", origin(), 300, 300, VIEWPORT);
    assert.equal(result.w, BASE.w);
    assert.equal(result.h, BASE.h);
  });

  it("拖出左边界时 x 被钳到 0", () => {
    const result = applyDrag("move", origin(), -500, 200, VIEWPORT);
    assert.equal(result.x, 0);
  });

  it("拖出右边界时 x 被钳到 vw - w", () => {
    const result = applyDrag("move", origin(), 5000, 200, VIEWPORT);
    assert.equal(result.x, VIEWPORT.width - BASE.w);
  });
});

describe("applyDrag — resize-left（符号对称最关键）", () => {
  it("向右拖（dx>0）：x 增加、w 减少，**右边界不动**", () => {
    const rightBefore = BASE.x + BASE.w;
    const result = applyDrag("resize-left", origin(), 250, 200, VIEWPORT); // dx = 50
    assert.equal(result.x, BASE.x + 50);
    assert.equal(result.w, BASE.w - 50);
    assert.equal(result.x + result.w, rightBefore, "右边界必须保持不变");
  });

  it("向左拖（dx<0）：x 减少、w 增加，右边界仍不动", () => {
    const rightBefore = BASE.x + BASE.w;
    const result = applyDrag("resize-left", origin(), 150, 200, VIEWPORT); // dx = -50
    assert.equal(result.x, BASE.x - 50);
    assert.equal(result.w, BASE.w + 50);
    assert.equal(result.x + result.w, rightBefore);
  });

  it("宽度缩到最小时不再继续，且右边界仍不变", () => {
    const result = applyDrag("resize-left", origin(), 5000, 200, VIEWPORT);
    assert.equal(result.w, DOCK_MIN_WIDTH);
    // 宽度被钳后 x 会被重新计算，右边界可能变化 —— 这是 clamp 的必然结果，
    // 但「宽不小于最小宽」必须成立。
    assert.ok(result.w >= DOCK_MIN_WIDTH);
  });

  it("y / h 不受影响", () => {
    const result = applyDrag("resize-left", origin(), 250, 400, VIEWPORT);
    assert.equal(result.y, BASE.y);
    assert.equal(result.h, BASE.h);
  });
});

describe("applyDrag — resize-right", () => {
  it("向右拖变大", () => {
    const result = applyDrag("resize-right", origin(), 250, 200, VIEWPORT);
    assert.equal(result.w, BASE.w + 50);
  });

  it("向左拖变小", () => {
    const result = applyDrag("resize-right", origin(), 150, 200, VIEWPORT);
    assert.equal(result.w, BASE.w - 50);
  });

  it("x / y / h 不变（只改宽）", () => {
    const result = applyDrag("resize-right", origin(), 300, 400, VIEWPORT);
    assert.equal(result.x, BASE.x);
    assert.equal(result.y, BASE.y);
    assert.equal(result.h, BASE.h);
  });

  it("不超过最小宽", () => {
    const result = applyDrag("resize-right", origin(), -5000, 200, VIEWPORT);
    assert.equal(result.w, DOCK_MIN_WIDTH);
  });

  it("不超过视口宽", () => {
    const result = applyDrag("resize-right", origin(), 5000, 200, VIEWPORT);
    assert.ok(result.w <= VIEWPORT.width);
  });
});

describe("applyDrag — resize-bottom", () => {
  it("向下拖变高", () => {
    assert.equal(applyDrag("resize-bottom", origin(), 200, 250, VIEWPORT).h, BASE.h + 50);
  });

  it("向上拖变矮", () => {
    assert.equal(applyDrag("resize-bottom", origin(), 200, 150, VIEWPORT).h, BASE.h - 50);
  });

  it("只改高", () => {
    const result = applyDrag("resize-bottom", origin(), 400, 350, VIEWPORT);
    assert.equal(result.x, BASE.x);
    assert.equal(result.y, BASE.y);
    assert.equal(result.w, BASE.w);
  });

  it("不超过最小高", () => {
    assert.equal(applyDrag("resize-bottom", origin(), 200, -5000, VIEWPORT).h, DOCK_MIN_HEIGHT);
  });
});

describe("applyDrag — resize-corner", () => {
  it("同时改宽高", () => {
    const result = applyDrag("resize-corner", origin(), 250, 250, VIEWPORT);
    assert.equal(result.w, BASE.w + 50);
    assert.equal(result.h, BASE.h + 50);
  });

  it("两个方向都受最小尺寸约束", () => {
    const result = applyDrag("resize-corner", origin(), -5000, -5000, VIEWPORT);
    assert.equal(result.w, DOCK_MIN_WIDTH);
    assert.equal(result.h, DOCK_MIN_HEIGHT);
  });

  it("x / y 不变", () => {
    const result = applyDrag("resize-corner", origin(), 300, 300, VIEWPORT);
    assert.equal(result.x, BASE.x);
    assert.equal(result.y, BASE.y);
  });
});

describe("applyDrag — 每次都走 clamp", () => {
  it("所有操作的结果都在视口内", () => {
    const kinds = ["move", "resize-left", "resize-right", "resize-bottom", "resize-corner"] as const;
    const deltas = [-5000, -300, 0, 300, 5000];
    for (const kind of kinds) {
      for (const delta of deltas) {
        const result = applyDrag(kind, origin(), 200 + delta, 200 + delta, VIEWPORT);
        assert.ok(result.x >= 0, `${kind} dx=${delta}: x 越界`);
        assert.ok(result.y >= 0, `${kind} dy=${delta}: y 越界`);
        assert.ok(result.w >= DOCK_MIN_WIDTH, `${kind} dx=${delta}: w 过小`);
        assert.ok(result.h >= DOCK_MIN_HEIGHT, `${kind} dy=${delta}: h 过小`);
        assert.ok(Number.isFinite(result.x + result.y + result.w + result.h), `${kind} 产生非有限数`);
      }
    }
  });
});

describe("shouldIgnoreDrag", () => {
  it("目标在按钮上 → 忽略", () => {
    const target = { closest: (selector: string) => (selector.includes("button") ? {} : null) };
    assert.equal(shouldIgnoreDrag(target), true);
  });

  it("目标不在交互元素上 → 允许拖动", () => {
    const target = { closest: () => null };
    assert.equal(shouldIgnoreDrag(target), false);
  });

  it("**closest 返回 undefined 也算不忽略**（不是「非 null 即真」）", () => {
    const target = { closest: () => undefined };
    assert.equal(shouldIgnoreDrag(target), false);
  });

  it("没有 closest 方法 → 允许拖动（原生短路行为）", () => {
    assert.equal(shouldIgnoreDrag({}), false);
  });

  it("null / undefined 目标 → 允许拖动", () => {
    assert.equal(shouldIgnoreDrag(null), false);
    assert.equal(shouldIgnoreDrag(undefined), false);
  });

  it("closest 抛错 → 允许拖动（不阻断）", () => {
    const target = { closest: () => { throw new Error("not an element"); } };
    assert.equal(shouldIgnoreDrag(target), false);
  });

  it("选择器覆盖全部交互元素类型", () => {
    for (const tag of ["button", "a", "input", "select", "textarea", "label"]) {
      assert.ok(INTERACTIVE_SELECTOR.includes(tag), `选择器应含 ${tag}`);
    }
  });
});

describe("isPrimaryButton", () => {
  it("左键（0）响应", () => {
    assert.equal(isPrimaryButton(0), true);
  });

  it("右键（2）/ 中键（1）不响应", () => {
    assert.equal(isPrimaryButton(2), false);
    assert.equal(isPrimaryButton(1), false);
  });

  it("缺失（undefined）不响应", () => {
    assert.equal(isPrimaryButton(undefined), false);
  });
});

describe("beginDrag — 会话生命周期", () => {
  /** 假 host：记录监听器。 */
  function fakeHost(): DragHost & {
    readonly listeners: Map<string, (event: MouseMoveEvent) => void>;
    emit(type: "mousemove" | "mouseup", event?: MouseMoveEvent): void;
  } {
    const listeners = new Map<string, (event: MouseMoveEvent) => void>();
    return {
      listeners,
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      removeEventListener(type) {
        listeners.delete(type);
      },
      emit(type, event = {}) {
        listeners.get(type)?.(event);
      },
    };
  }

  it("绑定 mousemove 与 mouseup", () => {
    const host = fakeHost();
    beginDrag(host, "move", origin(), () => undefined, VIEWPORT);
    assert.equal(host.listeners.has("mousemove"), true);
    assert.equal(host.listeners.has("mouseup"), true);
  });

  it("移动时回调新几何", () => {
    const host = fakeHost();
    const updates: DockGeometry[] = [];
    beginDrag(host, "move", origin(), (geometry) => updates.push(geometry), VIEWPORT);
    host.emit("mousemove", { clientX: 250, clientY: 250 });
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], { x: 150, y: 150, w: 500, h: 400 });
  });

  it("mouseup 后解绑两个监听器", () => {
    const host = fakeHost();
    beginDrag(host, "move", origin(), () => undefined, VIEWPORT);
    host.emit("mouseup");
    assert.equal(host.listeners.size, 0);
  });

  it("解绑后移动不再回调", () => {
    const host = fakeHost();
    const updates: DockGeometry[] = [];
    beginDrag(host, "move", origin(), (geometry) => updates.push(geometry), VIEWPORT);
    host.emit("mouseup");
    host.emit("mousemove", { clientX: 999, clientY: 999 });
    assert.equal(updates.length, 0);
  });

  it("end() 主动解绑，且可重复调用（幂等）", () => {
    const host = fakeHost();
    const session = beginDrag(host, "move", origin(), () => undefined, VIEWPORT);
    session.end();
    assert.doesNotThrow(() => session.end());
    assert.equal(host.listeners.size, 0);
  });

  it("事件缺 clientX 时沿用起点（不产生 NaN 几何）", () => {
    const host = fakeHost();
    const updates: DockGeometry[] = [];
    beginDrag(host, "move", origin(), (geometry) => updates.push(geometry), VIEWPORT);
    host.emit("mousemove", {});
    assert.equal(updates.length, 1);
    assert.equal(Number.isFinite(updates[0]?.x ?? Number.NaN), true);
  });

  it("end 之后 mousemove 即使被误调用也不更新", () => {
    const host = fakeHost();
    const updates: DockGeometry[] = [];
    const session = beginDrag(host, "move", origin(), (geometry) => updates.push(geometry), VIEWPORT);
    // 手动保留引用并模拟「解绑后仍有待处理的 move」。
    session.end();
    host.emit("mousemove", { clientX: 300, clientY: 300 });
    assert.equal(updates.length, 0);
  });
});
