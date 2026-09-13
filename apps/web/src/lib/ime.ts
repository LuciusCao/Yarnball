import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * IME Enter 守卫（issue #4 同款三重判定，从 ChatPanel 抽出复用）。
 * WebKit（Tauri 桌面壳 / Safari）下按 Enter 确认输入法候选时，compositionend 先于
 * 那次 Enter 的 keydown 派发，且 keydown 的 isComposing 已为 false、keyCode 为 13，
 * 单靠 nativeEvent.isComposing 拦不住，半成品文本会被误提交。
 * 三重判定：nativeEvent.isComposing + keyCode 229 + compositionstart/end 自维护标志位
 * （compositionend 后延迟一个宏任务复位：紧随的「确认候选」Enter 仍视为组合输入被忽略；
 * 用户真正想提交的 Enter 是后续独立输入事件，届时标志位已复位，不受影响）。
 *
 * 用法：
 *   const ime = useImeEnterGuard();
 *   <input {...ime.compositionProps} onKeyDown={(e) => {
 *     if (e.key === "Enter" && !ime.isComposingEnter(e)) ...;
 *   }} />
 */
export function useImeEnterGuard() {
  /** IME 组合输入标志位：compositionstart/end 自维护 */
  const imeComposingRef = useRef(false);
  /** compositionend 后延迟复位标志位的定时器 */
  const imeResetTimerRef = useRef<number | null>(null);

  const compositionProps = {
    onCompositionStart: () => {
      // 新一轮组合开始时取消尚未执行的复位，避免误清标志位
      if (imeResetTimerRef.current !== null) {
        clearTimeout(imeResetTimerRef.current);
        imeResetTimerRef.current = null;
      }
      imeComposingRef.current = true;
    },
    onCompositionEnd: () => {
      imeResetTimerRef.current = window.setTimeout(() => {
        imeComposingRef.current = false;
        imeResetTimerRef.current = null;
      }, 0);
    },
  };

  /** 当前 Enter 按键是否处于 IME 组合输入中（是则不应触发提交） */
  const isComposingEnter = (e: ReactKeyboardEvent): boolean =>
    e.nativeEvent.isComposing || e.keyCode === 229 || imeComposingRef.current;

  return { compositionProps, isComposingEnter };
}
