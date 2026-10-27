/**
 * 星曜元数据 —— 类型归属与亮度映射
 *
 * 为什么单独成文件：
 *   亮度映射（庙旺→bright/normal/dim）和星曜类型判定（主星/吉星/煞星）原来内联在
 *   algorithm.ts 里，流派后处理（school-apply.ts）也要用同一套规则。
 *   复制一份会出现「同一颗星两处判定不同」的隐患，故抽到这里共用。
 */

import type { Star, StarBrightness } from './types';

// ─── 亮度映射 ────────────────────────────────────────────────────────────

/**
 * 亮度原始值 → 粗粒度（供算法判断强弱使用）。
 *
 * 口径与改造前 algorithm.ts 内联版本逐字一致：庙旺为强、陷不闲为弱、其余归中。
 * 尤其「得」算中不算强——曾有版本把「得」并入 bright，会改变 strengthScore 一类判断，别改。
 */
export function mapBrightness(b?: string): 'bright' | 'normal' | 'dim' {
  if (!b) return 'normal';
  if (b === '庙' || b === '旺') return 'bright';
  if (b === '陷' || b === '不' || b === '闲') return 'dim';
  return 'normal';
}

const BRIGHTNESS_RAW_VALUES: StarBrightness[] = ['庙', '旺', '得', '利', '平', '不', '闲', '陷', '地'];

/** 从 iztro 原始亮度文本中提取标准 8 档之一 */
export function extractRawBrightness(b?: string): StarBrightness | undefined {
  if (!b) return undefined;
  for (const x of BRIGHTNESS_RAW_VALUES) {
    if (b.includes(x)) return x;
  }
  return undefined;
}

// ─── 星曜类型归属 ────────────────────────────────────────────────────────

/** 煞星 / 半凶杂曜 —— 先按名单判，名单里没有才回落到 iztro 自带的 type */
const SHA_STARS = new Set([
  '擎羊', '陀罗', '火星', '铃星', '地空', '地劫',
  '天空', '旬空', '副旬', '截路', '截空', '副截', '大耗', '天使', '天伤',
  '天刑', '天哭', '天虚', '天月', '阴煞', '蜚廉', '空亡',
  '孤辰', '寡宿',
]);

/** 吉星 / 吉杂曜 —— 同上 */
const LUCKY_STARS = new Set([
  '文昌', '文曲', '左辅', '右弼', '天魁', '天钺',
  '禄存', '天马', '天官', '天福', '天才', '天寿', '三台', '八座', '恩光',
  '天贵', '台辅', '龙池', '凤阁', '红鸾', '天喜',
  '解神', '天德', '月德', '年解', '天巫', '华盖', '封诰',
]);

/**
 * 判定星曜类型。
 * iztro 的 adjectiveStars 一律标 type='minor'，直接取会把红鸾/天喜、天刑/天哭 错分类，
 * 所以先查名单，名单未收录时才信任 iztro 的 type。
 */
export function mapStarType(starName: string, iztroType: string): Star['type'] {
  if (SHA_STARS.has(starName)) return 'sha';
  if (LUCKY_STARS.has(starName)) return 'lucky';
  const t = (iztroType ?? '').toLowerCase();
  if (t === '主星' || t === 'major') return 'major';
  if (t === '煞星' || t === 'tough') return 'sha';
  if (t === '吉星' || t === 'soft' || t === '禄存' || t === '天马') return 'lucky';
  return 'minor';
}
