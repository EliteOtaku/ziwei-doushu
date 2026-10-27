/**
 * 排盘流派后处理 —— 把 SchoolConfig 的开关作用到 iztro 排出的宫位上
 *
 * 为什么单独成文件：
 *   algorithm.ts 负责「用 iztro 排出基础盘」，本文件负责「按流派修正基础盘」。
 *   两者职责不同；混在一起时 algorithm.ts 已过 660 行，改一处容易误伤另一处。
 *
 * 调用时机：generateChart 组装完 palaces、拿到 lunarInfo 之后调用 applySchoolConfig。
 *
 * ── 各开关的实现依据（逐个实测 iztro 后确定）──────────────────────────
 *   1. 亮度表      —— 装配层查 schoolStarBrightness；后处理搬星后按新宫重算
 *   2. 庚年四化    —— 改星曜 siHua 标记；庚年只可能涉及 太阳/武曲/天府/天相/太阴/天同
 *   3. 安天马      —— 年支版 = iztro 原生；月支版 = 用月支查同一张三合表重定位
 *   4. 安天空      —— 常规 = 年支+1（iztro 原生，12 年支实测全中）；顺加生时 = 年支+1+时支
 *   5. 截空旬空    —— 双星 = iztro + 阴干对调；单星 / 占验派走 JK_ARR1 / JK_ARR3 表
 *   6. 安魁钺      —— 4 张 KY 表直接换位（iztro 只有一种）
 *   7. 天使天伤    —— 常规 = 奴仆/疾厄固定；中州派 = 阴男阳女时对调
 *   8. 长生十二神  —— 默认 = iztro 原生；火土共长生 = 土五局改起寅重排
 *   9. 晚子时      —— 不在本文件处理（改传入 generateChart 的日期，见 share.ts）
 *  10. 闰月归属    —— 不在本文件处理（改 generateChart 的 leapMonth 参数）
 */

import type { Palace, Star } from './types';
import type { SchoolConfig } from './school-config';
import { SCHOOL_AX } from './school-tables.generated';
import {
  SCHOOL_SIHUA_GENG_VARIANTS,
  SCHOOL_STAR_ID_TO_NAME,
  schoolStarBrightness,
  type BrightnessSchool,
} from './school-data';
import { mapBrightness, extractRawBrightness, mapStarType } from './star-meta';

// ─── 宫位操作原语 ─────────────────────────────────────────────────────────

/** 按星名找它所在的宫 */
function findPalaceWithStar(palaces: Palace[], name: string): Palace | undefined {
  return palaces.find((p) => p.stars.some((s) => s.name === name));
}

/** 按新宫地支重算亮度 —— 亮度是「星 × 宫」的函数，搬宫后必须跟着变 */
function refreshBrightness(star: Star, branch: number, school: BrightnessSchool): void {
  const rb = schoolStarBrightness(star.name, branch, school);
  star.brightness = mapBrightness(rb);
  star.brightnessRaw = extractRawBrightness(rb);
}

/**
 * 把某颗星搬到目标宫。已在目标宫则不动作。
 * 目标宫不存在时放回原处，不留半状态。
 */
function relocateStar(
  palaces: Palace[],
  name: string,
  targetBranch: number,
  school: BrightnessSchool,
): void {
  const from = findPalaceWithStar(palaces, name);
  if (!from || from.branch === targetBranch) return;
  const idx = from.stars.findIndex((s) => s.name === name);
  if (idx < 0) return;
  const [moved] = from.stars.splice(idx, 1);
  const target = palaces.find((p) => p.branch === targetBranch);
  if (!target) {
    from.stars.push(moved);
    return;
  }
  refreshBrightness(moved, targetBranch, school);
  target.stars.push(moved);
}

/**
 * 交换两颗星所在的宫位。
 * 天使天伤对调用 relocate 两次做不到：第一次搬走后第二次会找不到目标，必须一次性交换。
 */
function swapStars(palaces: Palace[], nameA: string, nameB: string, school: BrightnessSchool): void {
  const pa = findPalaceWithStar(palaces, nameA);
  const pb = findPalaceWithStar(palaces, nameB);
  if (!pa || !pb || pa === pb) return;
  const ia = pa.stars.findIndex((s) => s.name === nameA);
  const ib = pb.stars.findIndex((s) => s.name === nameB);
  if (ia < 0 || ib < 0) return;
  const [sa] = pa.stars.splice(ia, 1);
  const [sb] = pb.stars.splice(ib, 1);
  refreshBrightness(sa, pb.branch, school);
  refreshBrightness(sb, pa.branch, school);
  pb.stars.push(sa);
  pa.stars.push(sb);
}

/** 往指定宫补一颗本命星（已存在同名星时不动） */
function pushNatalStar(
  palaces: Palace[],
  branch: number,
  name: string,
  school: BrightnessSchool,
): void {
  const target = palaces.find((p) => p.branch === branch);
  if (!target || target.stars.some((s) => s.name === name)) return;
  const rb = schoolStarBrightness(name, branch, school);
  target.stars.push({
    name,
    type: mapStarType(name, ''),
    brightness: mapBrightness(rb),
    brightnessRaw: extractRawBrightness(rb),
  });
}

/** 把某颗星从盘上摘掉 */
function removeStar(palaces: Palace[], name: string): void {
  for (const p of palaces) {
    const i = p.stars.findIndex((s) => s.name === name);
    if (i >= 0) p.stars.splice(i, 1);
  }
}

// ─── 2. 庚年四化 ─────────────────────────────────────────────────────────

/** 庚年四化五种变体的候选星并集 —— 换表时只需清这六颗 */
const GENG_SIHUA_CANDIDATES = new Set(['太阳', '武曲', '天府', '天相', '太阴', '天同']);

/** 庚的天干索引 */
const GENG_INDEX = 6;

/**
 * 庚年四化变体。
 *
 * 为什么改标记而不是 astro.config({mutagens})：
 *   iztro 的 config 是全局副作用，generateChart 被多页面调用，全局配置泄漏会让别的盘跟着变。
 *   四化标记只影响星曜上的 siHua 字段，排完直接改字段零副作用。
 */
function applyGengSihua(
  palaces: Palace[],
  yearStem: number,
  variant: SchoolConfig['gengYearSihua'],
): void {
  if (yearStem !== GENG_INDEX || variant === 'GYWYT') return; // 非庚年 / 默认口径：iztro 本来就对
  const row = SCHOOL_SIHUA_GENG_VARIANTS[variant]; // [0, 禄, 权, 科, 忌] 星 ID
  const [lu, quan, ke, ji] = row.slice(1).map((id) => SCHOOL_STAR_ID_TO_NAME[id]);
  if (!lu || !quan || !ke || !ji) return;
  const assign = new Map<string, '禄' | '权' | '科' | '忌'>([
    [lu, '禄'], [quan, '权'], [ke, '科'], [ji, '忌'],
  ]);
  for (const p of palaces) {
    for (const s of p.stars) {
      if (!GENG_SIHUA_CANDIDATES.has(s.name)) continue;
      // 先清空再打新标记；不清空会让旧科/忌残留成双四化
      s.siHua = assign.get(s.name);
    }
  }
}

// ─── 3. 安天马 ───────────────────────────────────────────────────────────

/**
 * 天马默认按年支：寅午戌在申、申子辰在寅、巳酉丑在亥、亥卯未在巳。这就是 iztro 的口径。
 * 月支版把同样的三合规则套在生月地支上，用同一张 TM 表重定位即可。
 */
function applyTianma(
  palaces: Palace[],
  monthBranch: number,
  school: SchoolConfig['tianmaSchool'],
  brightnessSchool: BrightnessSchool,
): void {
  if (school !== 'month-branch') return;
  const target = SCHOOL_AX.TM[monthBranch + 1] - 1; // 子起一 → 0 起
  if (target < 0) return;
  relocateStar(palaces, '天马', target, brightnessSchool);
}

// ─── 4. 安天空 ───────────────────────────────────────────────────────────

/**
 * 天空两种取法：
 *   常规     —— 生年支前一位（iztro 原生，12 年支实测全等于「年支+1」）
 *   顺加生时 —— 从年支前一位起子时顺数到生时，即 年支+1+时支
 */
function applyTiankong(
  palaces: Palace[],
  yearBranch: number,
  hour: number,
  school: SchoolConfig['tiankongSchool'],
  brightnessSchool: BrightnessSchool,
): void {
  if (school !== 'shun-jia-shi') return;
  relocateStar(palaces, '天空', (yearBranch + 1 + hour) % 12, brightnessSchool);
}

// ─── 5. 截空 / 旬空 ──────────────────────────────────────────────────────

/**
 * 截空三派：
 *   正副双星（默认）—— 对子甲己申酉 / 乙庚午未 / 丙辛辰巳 / 丁壬寅卯 / 戊癸子丑，
 *                      阳干截空落阳宫、副截落阴宫，阴干对调。iztro 一律「截路=阳宫、空亡=阴宫」，
 *                      所以只有阴干需要换宫。此段已按金标准盘核对。
 *   常规单星        —— 只排一颗，落位查 JK_ARR1；戊癸年落子丑。
 *   占验派          —— 只排一颗，落位查 JK_ARR3；戊癸年落戌亥（与常规的差别就在这两年）。
 *
 * 作用对象是 iztro 的「截路 / 空亡」，先统一改名为「截空 / 副截」再调整。
 */
function applyJiekong(
  palaces: Palace[],
  yearStem: number,
  school: SchoolConfig['jiekongSchool'],
  brightnessSchool: BrightnessSchool,
): void {
  // 改名 + 按新名字补亮度（iztro 原名在亮度表里查不到，阳干年不换宫会一直留白）
  for (const p of palaces) {
    for (const s of p.stars) {
      if (s.name === '截路') s.name = '截空';
      else if (s.name === '空亡') s.name = '副截';
      else continue;
      refreshBrightness(s, p.branch, brightnessSchool);
    }
  }

  if (school === 'double') {
    if (yearStem % 2 === 0) return; // 阳干 iztro 已正确
    swapStars(palaces, '截空', '副截', brightnessSchool);
    return;
  }

  // 单星口径：摘掉副截，截空按表重定位
  const table = school === 'single' ? SCHOOL_AX.JK_ARR1 : SCHOOL_AX.JK_ARR3;
  const target = table[yearStem + 1] - 1;
  removeStar(palaces, '副截');
  if (target >= 0) relocateStar(palaces, '截空', target, brightnessSchool);
}

/** 旬空成对：副旬落在另一支（旬空阳支 +1、阴支 −1）。固定口径，不随流派变。 */
function applyFuxun(palaces: Palace[], brightnessSchool: BrightnessSchool): void {
  const xun = findPalaceWithStar(palaces, '旬空');
  if (!xun) return;
  const fu = xun.branch % 2 === 0 ? (xun.branch + 1) % 12 : (xun.branch + 11) % 12;
  pushNatalStar(palaces, fu, '副旬', brightnessSchool);
}

// ─── 6. 安魁钺 ───────────────────────────────────────────────────────────

/**
 * 天魁天钺四派。iztro 只排一种（等同 qs1 的大部分年份），其余三派靠重定位。
 * 表按 [生年干] 取行、子起一编码；行内 [魁, 钺]。
 * 四派的差异只在庚辛壬癸四年。
 */
const KUIYUE_TABLES = {
  qs1: SCHOOL_AX.KY_ARR1,
  qs2: SCHOOL_AX.KY_ARR2,
  'zhong-yiming': SCHOOL_AX.KY_ARR3,
  network: SCHOOL_AX.KY_ARR4,
} as const;

function applyKuiyue(
  palaces: Palace[],
  yearStem: number,
  school: SchoolConfig['kuiyueSchool'],
  brightnessSchool: BrightnessSchool,
): void {
  const row = KUIYUE_TABLES[school][yearStem + 1];
  if (!row) return;
  relocateStar(palaces, '天魁', row[0] - 1, brightnessSchool);
  relocateStar(palaces, '天钺', row[1] - 1, brightnessSchool);
}

// ─── 7. 天使天伤 ─────────────────────────────────────────────────────────

/**
 * 天使天伤两种取法：
 *   常规   —— 天伤在奴仆宫、天使在疾厄宫，固定不看阴阳性别（iztro 默认）
 *   中州派 —— 「阳男阴女依此诀；若为阴男阳女，则天伤居疾厄、天使居奴仆」，即阴男阳女时对调
 *
 * 判定与 iztro 源码 getTianshiTianshangIndex 一致：年支索引偶数为阳支，男为阳，两者同阴阳则不换。
 */
function applyTianshiTianshang(
  palaces: Palace[],
  yearBranch: number,
  gender: 'male' | 'female',
  school: SchoolConfig['tianshiTianshang'],
  brightnessSchool: BrightnessSchool,
): void {
  if (school !== 'zhongzhou') return;
  const yearYang = yearBranch % 2 === 0;
  const genderYang = gender === 'male';
  if (yearYang === genderYang) return; // 阳男 / 阴女：依常规诀
  swapStars(palaces, '天使', '天伤', brightnessSchool);
}

// ─── 8. 长生十二神 ───────────────────────────────────────────────────────

const CHANGSHENG_ORDER = [
  '长生', '沐浴', '冠带', '临官', '帝旺', '衰', '病', '死', '墓', '绝', '胎', '养',
] as const;

/** 五行局 → 长生起点地支索引（0=子）。iztro 实测：水二局起申、木三局起亥、金四局起巳、土五局起申、火六局起寅。 */
const CHANGSHENG_START: Record<string, number> = {
  水二局: 8,  // 申
  木三局: 11, // 亥
  金四局: 5,  // 巳
  土五局: 8,  // 申（水土同宫，iztro 默认口径）
  火六局: 2,  // 寅
};

/**
 * 长生十二神。
 *   yin-yang-shun-ni / shui-tu —— 与 iztro 现状相同（土五局起申），不动
 *   huo-tu                    —— 土五局改起寅，整条链重排；其余四局与默认口径相同
 *
 * 顺逆：阳男阴女顺行、阴男阳女逆行（与 iztro 源码一致）。
 */
function applyChangsheng(
  palaces: Palace[],
  wuxingJuName: string,
  yearBranch: number,
  gender: 'male' | 'female',
  school: SchoolConfig['changshengSchool'],
): void {
  if (school !== 'huo-tu') return;
  if (wuxingJuName !== '土五局') return; // 其余四局没有差异
  const start = 2; // 寅
  const forward = (yearBranch % 2 === 0) === (gender === 'male'); // 阳男 / 阴女顺行
  for (let i = 0; i < 12; i++) {
    const branch = (((start + (forward ? i : -i)) % 12) + 12) % 12;
    const target = palaces.find((p) => p.branch === branch);
    if (target) target.changsheng12 = CHANGSHENG_ORDER[i];
  }
}

/** 把 iztro 的长生十二神写进我们自己的字段（未切换流派时也要有，否则盘面显示不出来） */
function copyChangsheng(palaces: Palace[], raw: Record<number, string | undefined>): void {
  for (const p of palaces) {
    const v = raw[p.branch];
    if (v) p.changsheng12 = v;
  }
}

// ─── 汇总入口 ────────────────────────────────────────────────────────────

export interface SchoolApplyContext {
  config: SchoolConfig;
  /** 生年天干索引 0-9（0=甲） */
  yearStem: number;
  /** 生年地支索引 0-11（0=子） */
  yearBranch: number;
  /** 农历月 1-12（闰月传绝对值） */
  lunarMonth: number;
  /** 时支索引 0-11 */
  hour: number;
  gender: 'male' | 'female';
  /** 五行局中文名，如「土五局」 */
  wuxingJuName: string;
  /** 当前生效的亮度派（'default' 已由调用方解析成 'QS'） */
  brightnessSchool: BrightnessSchool;
  /** iztro 原生的长生十二神（地支索引 → 神名），用于非切换场景直接落字段 */
  rawChangsheng: Record<number, string | undefined>;
}

/**
 * 一次性应用全部流派开关。
 *
 * 顺序有讲究：
 *   截空先改名，后续亮度按新名字才查得到；
 *   长生最后，它只写 changsheng12 字段，与星曜互不干扰。
 */
export function applySchoolConfig(palaces: Palace[], ctx: SchoolApplyContext): void {
  const {
    config, yearStem, yearBranch, lunarMonth, hour,
    gender, wuxingJuName, brightnessSchool, rawChangsheng,
  } = ctx;

  // 月支：农历正月建寅，地支索引 = 月 + 1
  const monthBranch = (Math.abs(lunarMonth) + 1) % 12;

  applyGengSihua(palaces, yearStem, config.gengYearSihua);
  applyTianma(palaces, monthBranch, config.tianmaSchool, brightnessSchool);
  applyTiankong(palaces, yearBranch, hour, config.tiankongSchool, brightnessSchool);
  applyJiekong(palaces, yearStem, config.jiekongSchool, brightnessSchool);
  applyFuxun(palaces, brightnessSchool);
  applyKuiyue(palaces, yearStem, config.kuiyueSchool, brightnessSchool);
  applyTianshiTianshang(palaces, yearBranch, gender, config.tianshiTianshang, brightnessSchool);
  applyDahao(palaces, yearBranch, brightnessSchool);
  copyChangsheng(palaces, rawChangsheng);
  applyChangsheng(palaces, wuxingJuName, yearBranch, gender, config.changshengSchool);
}

// ─── 年支大耗（不在 10 类开关里，但对齐默认口径必需）─────────────────────

/**
 * 本命顶栏「大耗」（年支星，不是宫底岁前十二神里那颗岁破）。
 * 按金标准盘核对十二年支：阳支岁破 +1，阴支岁破 −1。子=0 起偶数为阳支。
 */
export function schoolDahaoBranch(yearBranch: number): number {
  const suiPo = (yearBranch + 6) % 12;
  return yearBranch % 2 === 0 ? (suiPo + 1) % 12 : (suiPo + 11) % 12;
}

/** 把年支大耗补到本命盘（固定口径，不随流派变） */
function applyDahao(palaces: Palace[], yearBranch: number, brightnessSchool: BrightnessSchool): void {
  pushNatalStar(palaces, schoolDahaoBranch(yearBranch), '大耗', brightnessSchool);
}
