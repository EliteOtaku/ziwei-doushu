/**
 * lib/ai/chart-context —— 把结构化命盘压成给模型读的文本
 *
 * 为什么单独一层：
 *   模型的判断质量取决于它「看见」什么。直接把 ZiweiChart 的 JSON 丢过去，
 *   一是体积大、二是模型要自己从 branch 数字反推地支名字，容易出错。
 *   这里把宫位、星曜、亮度、四化、格局都翻成中文短句，模型只需做命理推理。
 *
 * 只读，不修改传进来的 chart —— 前端会把同一份对象同时用于渲染和请求。
 */

import type { ZiweiChart, Palace, Star } from '@/lib/ziwei/types';
import { BRANCHES, STEMS } from '@/lib/ziwei/constants';
import { detectPatterns, type Pattern } from '@/lib/ziwei/patterns';

const SHICHEN_NAMES = [
  '子时(23:00-01:00)', '丑时(01:00-03:00)', '寅时(03:00-05:00)', '卯时(05:00-07:00)',
  '辰时(07:00-09:00)', '巳时(09:00-11:00)', '午时(11:00-13:00)', '未时(13:00-15:00)',
  '申时(15:00-17:00)', '酉时(17:00-19:00)', '戌时(19:00-21:00)', '亥时(21:00-23:00)',
];

const BRIGHTNESS_TEXT: Record<string, string> = {
  庙: '庙', 旺: '旺', 得: '得', 利: '利', 平: '平', 不: '不', 闲: '闲', 陷: '陷', 地: '地',
};

function fmtStar(star: Star): string {
  const parts = [star.name];
  const brightness = star.brightnessRaw ?? (star.brightness === 'bright' ? '庙' : star.brightness === 'dim' ? '陷' : '平');
  if (star.type === 'major' && brightness && BRIGHTNESS_TEXT[brightness]) {
    parts.push(BRIGHTNESS_TEXT[brightness]);
  }
  if (star.siHua) parts.push(`化${star.siHua}`);
  return parts.join('');
}

function fmtPalace(palace: Palace, chart: ZiweiChart): string {
  const branchName = BRANCHES[palace.branch] ?? '?';
  const stemName = STEMS[palace.stem] ?? '';
  const marks: string[] = [];
  if (palace.branch === chart.mingGongBranch) marks.push('命宫');
  if (palace.branch === chart.shenGongBranch) marks.push('身宫');
  if (palace.isCurrentDaXian) marks.push('当前大限');

  const head = `【${palace.name}】${stemName}${branchName}宫${marks.length ? `（${marks.join('·')}）` : ''}`;

  const lines: string[] = [head];

  if (palace.daXianAge) {
    lines.push(`  大限：${palace.daXianAge[0]}-${palace.daXianAge[1]} 岁`);
  }

  const major = palace.stars.filter(s => s.type === 'major');
  const lucky = palace.stars.filter(s => s.type === 'lucky');
  const sha = palace.stars.filter(s => s.type === 'sha');
  const minor = palace.stars.filter(s => s.type === 'minor');

  if (major.length > 0) {
    lines.push(`  主星：${major.map(fmtStar).join('、')}`);
  } else if (palace.isEmpty) {
    const borrowed = palace.borrowedStars?.length
      ? palace.borrowedStars.join('、')
      : '（对宫无主星）';
    lines.push(`  主星：空宫，借对宫【${palace.borrowedFromName ?? '?'}】的 ${borrowed}`);
  }

  if (minor.length > 0) lines.push(`  辅星：${minor.map(fmtStar).join('、')}`);
  if (lucky.length > 0) lines.push(`  吉星：${lucky.map(fmtStar).join('、')}`);
  if (sha.length > 0) lines.push(`  煞星：${sha.map(fmtStar).join('、')}`);

  if (palace.selfSihua?.length) {
    lines.push(`  宫干自化：${palace.selfSihua.map(s => `${s.starName}化${s.siHua}`).join('、')}`);
  }

  return lines.join('\n');
}

/** 命盘 → 供模型阅读的完整文本块 */
export function formatChart(chart: ZiweiChart): string {
  const b = chart.birthInfo;
  const lunar = chart.lunarInfo;
  const genderText = b.gender === 'male' ? '男' : '女';
  const shichen = SHICHEN_NAMES[b.hour] ?? `索引${b.hour}`;
  const birthplace = [b.province, b.city].filter(Boolean).join(' ');

  const blocks: string[] = [];

  blocks.push(
    [
      '## 基本信息',
      `姓名：${b.name || '未提供'}`,
      `性别：${genderText}${chart.yinYangGender ? `（${chart.yinYangGender}）` : ''}`,
      `阳历：${b.year} 年 ${b.month} 月 ${b.day} 日 ${shichen}`,
      `农历：${lunar.lunarYear} 年${lunar.isLeapMonth ? '闰' : ''}${Math.abs(lunar.lunarMonth)} 月 ${lunar.lunarDay} 日`,
      `年干支：${STEMS[lunar.yearStem] ?? ''}${BRANCHES[lunar.yearBranch] ?? ''}`,
      lunar.fourPillars ? `节气四柱：${lunar.fourPillars.join(' ')}` : '',
      lunar.fourPillarsLunar ? `农历四柱：${lunar.fourPillarsLunar.join(' ')}` : '',
      birthplace ? `出生地：${birthplace}` : '',
      `五行局：${chart.wuxingJuName}`,
      `命主：${chart.mingZhu || '—'}　身主：${chart.shenZhu || '—'}`,
      `命宫地支：${BRANCHES[chart.mingGongBranch]}　身宫地支：${BRANCHES[chart.shenGongBranch]}`,
      `当前年龄：${chart.currentAge} 岁`,
    ]
      .filter(Boolean)
      .join('\n'),
  );

  // 当前大限单独拎出来，模型最容易忽略它
  const current = chart.daXians[chart.currentDaXianIndex];
  if (current) {
    const sihua = current.siHua
      ? `，大限四化：禄${current.siHua.lu} 权${current.siHua.quan} 科${current.siHua.ke} 忌${current.siHua.ji}`
      : '';
    blocks.push(
      `## 当前大限\n${current.startAge}-${current.endAge} 岁，行【${current.palaceName}】${current.stemName ? `（${current.stemName}干）` : ''}${sihua}`,
    );
  }

  // 星曜按宫位输出。palaces 本身按地支 0-11 排，保持原序便于对照盘面
  blocks.push(`## 十二宫\n${chart.palaces.map(p => fmtPalace(p, chart)).join('\n\n')}`);

  let patterns: Pattern[];
  try {
    patterns = detectPatterns(chart);
  } catch {
    patterns = [];
  }
  if (patterns.length > 0) {
    const levelText: Record<string, string> = {
      excellent: '上格', good: '吉格', neutral: '常格', caution: '需警惕',
    };
    blocks.push(
      `## 已识别格局\n${patterns
        .map(p => {
          const cond = p.conditions?.required?.length ? `（成立条件：${p.conditions.required.join('；')}）` : '';
          return `- 【${p.name}】${levelText[p.level] ?? ''}：${p.description}${cond}`;
        })
        .join('\n')}`,
    );
  }

  return blocks.join('\n\n');
}
