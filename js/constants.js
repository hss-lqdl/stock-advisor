/* ============================================================
   constants.js — 交易时段与下单窗口的单一事实来源
   ------------------------------------------------------------
   尾盘窗口（14:55 开始挂单，15:00 收盘）原先散落在 engine.js、
   plan.js、main.js 和各个 view 的文案里，改一处容易漏一处。
   统一到这里：
     · 时段判断（marketPhase / msToTail）用 TAIL_START_MIN / TAIL_END_MIN
     · 界面与复制文案用 TAIL_WINDOW_TEXT / TAIL_HHMM
   改时间只改本文件。
   ============================================================ */

/** 尾盘窗口开始：14:55 */
export const TAIL_START_H = 14;
export const TAIL_START_M = 55;

/** 收盘：15:00 */
export const TAIL_END_H = 15;
export const TAIL_END_M = 0;

/** 当日分钟数：895 / 900 */
export const TAIL_START_MIN = TAIL_START_H * 60 + TAIL_START_M;
export const TAIL_END_MIN = TAIL_END_H * 60 + TAIL_END_M;

/** 文案用的时间标签 */
export const TAIL_HHMM = '14:55';
export const CLOSE_HHMM = '15:00';

/** 收盘集合竞价开始 */
export const CLOSE_AUCTION_HHMM = '14:57';

/** 「尾盘 14:55–15:00」 */
export const TAIL_WINDOW_TEXT = `尾盘 ${TAIL_HHMM}–${CLOSE_HHMM}`;
