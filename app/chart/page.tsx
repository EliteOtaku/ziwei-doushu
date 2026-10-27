'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import BirthForm, { type BirthFormState } from '@/components/BirthForm';
import ChartBoard from '@/components/ChartBoard';
import InsightPanel from '@/components/InsightPanel';
import TimeNav, { type TimeView } from '@/components/TimeNav';
import SchoolDrawer, { readConfigFromUrl } from '@/components/SchoolDrawer';
import { generateChart } from '@/lib/ziwei/algorithm';
import { formToBirthInfo, formToSearchParams } from '@/lib/ziwei/share';
import {
  loadSchoolConfig,
  saveSchoolConfig,
  configToParams,
  SCHOOL_DEFAULT_CONFIG,
  type SchoolConfig,
} from '@/lib/ziwei/school-config';
import type { BirthInfo, ZiweiChart, Palace } from '@/lib/ziwei/types';

/**
 * 命盘页 —— 排盘引擎 + 流派设置
 *
 * 用本仓库的排盘引擎 generateChart() 配合基础 UI 组件，渲染一张完整紫微命盘 +
 * 基础解读，支持本命 / 大限 / 流年切换，并可在右侧抽屉切换 10 类排盘流派。
 *
 * 说明：线上商业版的完整交互界面（重设计的新 UI、AI 流式解读、合盘、分享
 * 卡片等）不在开源范围内；但排盘内核——安星算法、四化、格局识别、古籍库——
 * 完全开放（见 lib/ziwei/*），可自由二次开发出你自己的界面。
 */
export default function ChartPage() {
  const [chart, setChart] = useState<ZiweiChart | null>(null);
  const [selectedPalace, setSelectedPalace] = useState<Palace | null>(null);
  const [view, setView] = useState<TimeView>('mingpan');
  const [liunianYear, setLiunianYear] = useState(() => new Date().getFullYear());

  // ── 流派配置：URL 参数优先（分享链接），否则读本机 localStorage ──
  const [schoolConfig, setSchoolConfig] = useState<SchoolConfig>(SCHOOL_DEFAULT_CONFIG);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 记录最近一次起盘用的出生信息，切换流派时用它重排
  const [birthInfo, setBirthInfo] = useState<BirthInfo | null>(null);
  // 同时保留原始表单（未做晚子时日期推进），切 lateZishi 时要用它重新换算
  const [formState, setFormState] = useState<BirthFormState | null>(null);

  useEffect(() => {
    const fromUrl = readConfigFromUrl();
    setSchoolConfig(fromUrl ?? loadSchoolConfig());
  }, []);

  const changedCount = useMemo(
    () => (Object.keys(SCHOOL_DEFAULT_CONFIG) as (keyof SchoolConfig)[])
      .filter(k => schoolConfig[k] !== SCHOOL_DEFAULT_CONFIG[k]).length,
    [schoolConfig],
  );

  // 切换流派：保存 → 若有盘则按新口径重排
  // ★ 必须连同 lateZishi 一起重新换算 birthInfo：晚子时（23:00-23:59）在 next-day
  //   口径下要把日期 +1，current-day 则不动。若只换 schoolConfig 而沿用旧 birthInfo，
  //   日期早已按旧口径固化，切「视为当日」不会生效（用户会以为开关坏了）。
  const handleConfigChange = useCallback((next: SchoolConfig) => {
    setSchoolConfig(next);
    saveSchoolConfig(next);
    if (formState) {
      try {
        const info = formToBirthInfo(formState, next.lateZishi);
        setBirthInfo(info);
        setChart(generateChart(info, { schoolConfig: next, leapMonth: next.leapMonth }));
      } catch { /* 排盘失败保持原盘 */ }
    }
  }, [formState]);

  const handleSubmit = useCallback((info: BirthInfo, form: BirthFormState) => {
    setFormState(form);
    setBirthInfo(info);
    setChart(generateChart(info, { schoolConfig, leapMonth: schoolConfig.leapMonth }));
  }, [schoolConfig]);

  // ── 未起盘：展示出生信息表单 ──
  if (!chart) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: '48px 20px' }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>紫微斗数排盘</h1>
        <p style={{ color: '#888', marginBottom: 12, fontSize: 14, lineHeight: 1.7 }}>
          输入出生年月日时，排盘引擎即时生成命盘。
        </p>
        <p
          style={{
            color: '#a8894a',
            marginBottom: 32,
            fontSize: 13,
            lineHeight: 1.8,
            padding: '10px 14px',
            border: '1px solid rgba(212,168,67,0.25)',
            borderRadius: 8,
            background: 'rgba(212,168,67,0.06)',
          }}
        >
          <strong>起盘后右侧会出现「AI 命理解读」面板</strong>
          ：自动生成命格总览，可切换感情 / 事业 / 财运 / 健康 / 性格，也能直接在输入框追问。
          <br />
          <span style={{ opacity: 0.75 }}>
            首次出字需要等 30–60 秒（模型思考阶段），期间面板会显示倒计时。
          </span>
        </p>
        <BirthForm onSubmit={handleSubmit} lateZishi={schoolConfig.lateZishi} />
      </main>
    );
  }

  // ── 已起盘：命盘 + 解读 ──
  return (
    <main style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => { setChart(null); setSelectedPalace(null); setBirthInfo(null); setFormState(null); }}
          style={{
            padding: '6px 14px', cursor: 'pointer',
            border: '1px solid #ccc', borderRadius: 8, background: 'transparent',
          }}
        >
          ← 重新起盘
        </button>
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          style={{
            padding: '6px 14px', cursor: 'pointer',
            border: `1px solid ${changedCount ? 'var(--ac-bdr)' : '#ccc'}`,
            borderRadius: 8,
            background: changedCount ? 'var(--ac-bg)' : 'transparent',
            color: changedCount ? 'var(--ac)' : 'inherit',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          排盘流派
          {changedCount > 0 && (
            <span style={{ fontSize: 10, fontWeight: 600 }}>{changedCount}</span>
          )}
        </button>
      </div>

      <TimeNav
        chart={chart}
        view={view}
        liunianYear={liunianYear}
        onViewChange={setView}
        onYearChange={setLiunianYear}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 380px)',
          gap: 20, marginTop: 16, alignItems: 'start',
        }}
      >
        <ChartBoard chart={chart} onPalaceSelect={setSelectedPalace} />
        <InsightPanel chart={chart} selectedPalace={selectedPalace} />
      </div>

      <SchoolDrawer
        open={drawerOpen}
        config={schoolConfig}
        onChange={handleConfigChange}
        onClose={() => setDrawerOpen(false)}
      />
    </main>
  );
}
