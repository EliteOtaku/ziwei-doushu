/**
 * 回归测试 — 流派开关必须真的改变排盘（2026-10-27）
 *
 * 起因: `lib/ziwei/school-config.ts` 定义了 10 类流派开关，但全站零引用，
 *       UI 完全没有接入——用户勾了什么都不会变。这次把开关接到排盘内核后，
 *       用本测试锁住两件事:
 *         1) 每个非默认选项都必须在某张盘上产出与默认不同的结果（否则就是假开关）；
 *         2) 默认配置必须与"不传 schoolConfig"完全一致（默认口径不许被改坏）。
 *
 * 跑: npx tsx scripts/regression/school-switches.test.ts
 */
import { generateChart } from '../../lib/ziwei/algorithm';
import { formToBirthInfo } from '../../lib/ziwei/share';
import {
  SCHOOL_DEFAULT_CONFIG,
  SCHOOL_OPTIONS,
  type SchoolConfig,
} from '../../lib/ziwei/school-config';
import type { BirthInfo } from '../../lib/ziwei/types';

let failures = 0;
const fail = (msg: string) => { console.error(`  ✗ ${msg}`); failures++; };
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

/** 覆盖阴阳年 × 男女 × 多时辰 × 多五行局，确保每个开关都能找到触发样本 */
const CASES: BirthInfo[] = [];
for (const year of [1984, 1985, 1988, 1990, 1991, 1993, 2000, 2001]) {
  for (const gender of ['male', 'female'] as const) {
    for (const hour of [0, 2, 4, 6, 8, 10]) {
      CASES.push({ year, month: 5, day: 9, hour, gender });
    }
  }
}

/** 只取「与流派相关的可观测量」：星名 + 亮度 + 四化 + 长生，忽略动画/选中态等 UI 字段 */
function fingerprint(cfg: SchoolConfig, bi: BirthInfo): string {
  const c = generateChart(bi, { schoolConfig: cfg, leapMonth: cfg.leapMonth });
  return c.palaces
    .map(p =>
      `${p.branch}:` +
      p.stars.map(s => `${s.name}/${s.brightnessRaw ?? ''}/${s.siHua ?? ''}`).sort().join('+') +
      `#${p.changsheng12 ?? ''}`,
    )
    .join('|');
}

console.log(`\n流派开关回归 — ${CASES.length} 张盘 × ${Object.keys(SCHOOL_OPTIONS).length} 组开关\n`);

// ── 断言 1: 默认配置 === 不传配置 ──
{
  let bad = 0;
  for (const bi of CASES) {
    const withDefault = fingerprint(SCHOOL_DEFAULT_CONFIG, bi);
    const c2 = generateChart(bi); // 不传 schoolConfig
    const noArg = c2.palaces
      .map(p =>
        `${p.branch}:` +
        p.stars.map(s => `${s.name}/${s.brightnessRaw ?? ''}/${s.siHua ?? ''}`).sort().join('+') +
        `#${p.changsheng12 ?? ''}`,
      )
      .join('|');
    if (withDefault !== noArg) bad++;
  }
  if (bad) fail(`默认配置与不传 schoolConfig 有 ${bad}/${CASES.length} 张盘不一致（默认口径被改坏）`);
  else ok('默认配置与不传 schoolConfig 逐字节一致（默认口径未变）');
}

// ── 断言 2: 每个非默认选项都要真的改变排盘 ──
//
// 已知的「设计上就该无差异」的选项，白名单说明理由：
//   - shui-tu（水土共长生）：土五局起点本来就等于水二局起点（申），故与默认同 → 已在 UI 标注但不动内核
//   - QS / default：QS 就是默认底层表，等价是正确行为
const EXPECTED_NOOP = new Set<string>([
  'changshengSchool:shui-tu',   // 水土同宫，起点相同，本就无差异
  'brightnessSchool:default',   // = QS，默认项自身
  'brightnessSchool:QS',        // UI 不暴露，兼容旧配置时才出现
]);

let noopCount = 0;
const noopList: string[] = [];

for (const key of Object.keys(SCHOOL_OPTIONS) as (keyof SchoolConfig)[]) {
  // 晚子时/闰月改的是「传入 generateChart 的日期/参数」，用别的盘验证（见下面单独段落）
  if (key === 'lateZishi' || key === 'leapMonth') continue;

  const options = SCHOOL_OPTIONS[key] as readonly { value: string }[];
  const base = CASES.map(bi => fingerprint(SCHOOL_DEFAULT_CONFIG, bi));

  for (const opt of options) {
    const id = `${key}:${opt.value}`;
    if (opt.value === (SCHOOL_DEFAULT_CONFIG[key] as string)) continue;

    const cfg = { ...SCHOOL_DEFAULT_CONFIG, [key]: opt.value } as SchoolConfig;
    let diff = 0;
    for (let i = 0; i < CASES.length; i++) {
      if (fingerprint(cfg, CASES[i]) !== base[i]) diff++;
    }

    if (diff === 0) {
      if (EXPECTED_NOOP.has(id)) {
        ok(`${id} —— 与默认无差异（已说明：水土共长生起点相同）`);
      } else {
        noopCount++;
        noopList.push(id);
        fail(`${id} 与默认口径完全无差异（${CASES.length} 张盘都没变）→ 疑似开关未接入`);
      }
    } else {
      ok(`${id} → ${diff}/${CASES.length} 张盘发生变化`);
    }
  }
}

// ── 断言 3: 晚子时切换必须改变日期推进 ──
{
  const form = {
    name: '', year: '1990', month: '5', day: '9',
    clockHour: '23', clockMinute: '30', unknownTime: false,
    province: '北京市', city: '北京', longitude: 116.4, gender: 'male' as const,
  };
  const nextDay = formToBirthInfo(form, 'next-day');
  const sameDay = formToBirthInfo(form, 'current-day');
  const advanced = nextDay.day === 10 && sameDay.day === 9;
  if (advanced) ok('晚子时 23:30 → next-day 推到 5/10，current-day 留在 5/9');
  else fail(`晚子时切换无效：next-day=${nextDay.month}/${nextDay.day}，current-day=${sameDay.month}/${sameDay.day}`);
}

// ── 断言 4: 闰月切换必须改变农历月归属 ──
{
  // 2020 闰四月初十 ≈ 公历 2020-06-01
  const leapBi: BirthInfo = { year: 2020, month: 6, day: 1, hour: 4, gender: 'male' };
  const results = (['split', 'next-month', 'prev-month', 'origin-month'] as const).map(p => {
    const c = generateChart(leapBi, { schoolConfig: { ...SCHOOL_DEFAULT_CONFIG, leapMonth: p }, leapMonth: p });
    return `${p}:命宫${c.mingGongBranch}`;
  });
  const unique = new Set(results.map(r => r.split(':')[1]));
  if (unique.size >= 2) ok(`闰月四口径产生 ${unique.size} 种不同命宫 → ${results.join(' ')}`);
  else fail(`闰月四口径结果全同（命宫都是 ${[...unique][0]}），闰月开关可能未生效`);
}

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}${noopCount ? `（${noopList.length} 个假开关: ${noopList.join(', ')}）` : ''}\n`);
process.exit(failures === 0 ? 0 : 1);
