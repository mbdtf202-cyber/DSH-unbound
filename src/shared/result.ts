/**
 * 统一结果类型。
 *
 * 原项目大量函数「成功返回对象、失败抛异常、再被 catch 吞掉」，
 * 导致失败与「没有数据」无法区分。新代码对**预期内**的失败用 Result，
 * 对**编程错误**才抛。
 */

export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** 取值，失败时返回 fallback。 */
export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/** 抛异常的取值，用于「失败即 bug」的位置。 */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(typeof r.error === "string" ? r.error : JSON.stringify(r.error));
  return r.value;
}
