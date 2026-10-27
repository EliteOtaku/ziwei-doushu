'use client';

import { useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  SCHOOL_OPTIONS,
  SCHOOL_LABELS,
  SCHOOL_DEFAULT_CONFIG,
  configToParams,
  paramsToConfig,
  type SchoolConfig,
} from '@/lib/ziwei/school-config';

interface SchoolDrawerProps {
  open: boolean;
  config: SchoolConfig;
  onChange: (next: SchoolConfig) => void;
  onClose: () => void;
}

/** 分组顺序与 school-config 的 SchoolConfig 字段顺序一致 */
const GROUP_ORDER = Object.keys(SCHOOL_DEFAULT_CONFIG) as (keyof SchoolConfig)[];

export default function SchoolDrawer({ open, config, onChange, onClose }: SchoolDrawerProps) {
  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 与默认相比改了几项，用于标题角标
  const changedCount = useMemo(
    () => GROUP_ORDER.filter(k => config[k] !== SCHOOL_DEFAULT_CONFIG[k]).length,
    [config],
  );

  const set = <K extends keyof SchoolConfig>(key: K, value: SchoolConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="mask"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            style={{
              position: 'fixed', inset: 0, zIndex: 90,
              background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)',
            }}
          />
          <motion.aside
            key="panel"
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'tween', duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            role="dialog"
            aria-label="排盘流派设置"
            style={{
              position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 91,
              width: 'min(440px, 100vw)',
              // 抽屉必须有实底：--bg-card 在暗色主题是半透明的，直接铺会透出盘面
              background: 'var(--bg-1)',
              borderLeft: '1px solid var(--bdr-med)',
              boxShadow: 'var(--sh-lg)',
              display: 'flex', flexDirection: 'column',
            }}
          >
            {/* 头部 */}
            <div style={{
              padding: '18px 20px 14px',
              borderBottom: '1px solid var(--bdr)',
              background: 'var(--bg-1)',
              display: 'flex', alignItems: 'flex-start', gap: 12,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 15, fontWeight: 700, color: 'var(--tx-0)',
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  排盘流派
                  {changedCount > 0 && (
                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
                      color: 'var(--ac)', background: 'var(--ac-bg)',
                      border: '1px solid var(--ac-bdr)',
                    }}>
                      已改 {changedCount} 项
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--tx-3)', marginTop: 4, lineHeight: 1.6 }}>
                  默认口径与主流排盘软件一致。切换后立即重新排盘。
                </div>
              </div>
              <button
                type="button"
                onClick={() => onChange(SCHOOL_DEFAULT_CONFIG)}
                style={{
                  flexShrink: 0, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                  fontSize: 11.5, color: 'var(--tx-2)',
                  background: 'transparent', border: '1px solid var(--bdr-med)',
                }}
              >
                重置
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="关闭"
                style={{
                  flexShrink: 0, width: 26, height: 26, lineHeight: 1, borderRadius: 6,
                  cursor: 'pointer', fontSize: 16, color: 'var(--tx-3)',
                  background: 'transparent', border: '1px solid var(--bdr-med)',
                }}
              >
                ×
              </button>
            </div>

            {/* 分组列表 */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '6px 20px 20px' }}>
              {GROUP_ORDER.map((key, idx) => {
                const options = SCHOOL_OPTIONS[key] as readonly { value: string; label: string; desc?: string }[];
                const current = config[key] as string;
                const selected = options.find(o => o.value === current);
                return (
                  <section key={key} style={{ paddingTop: idx === 0 ? 14 : 18 }}>
                    <div style={{
                      fontSize: 12.5, fontWeight: 600, color: 'var(--tx-1)',
                      marginBottom: 8, display: 'flex', alignItems: 'baseline', gap: 6,
                    }}>
                      <span>{SCHOOL_LABELS[key]}</span>
                      {current !== (SCHOOL_DEFAULT_CONFIG[key] as string) && (
                        <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--ac)' }}>已改</span>
                      )}
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {options.map(opt => {
                        const active = opt.value === current;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => set(key, opt.value as SchoolConfig[typeof key])}
                            title={opt.desc}
                            aria-pressed={active}
                            style={{
                              padding: '5px 11px', borderRadius: 6, cursor: 'pointer',
                              fontSize: 12, lineHeight: 1.35,
                              color: active ? 'var(--ac)' : 'var(--tx-2)',
                              background: active ? 'var(--ac-bg)' : 'transparent',
                              border: `1px solid ${active ? 'var(--ac-bdr)' : 'var(--bdr-med)'}`,
                              fontWeight: active ? 600 : 400,
                              transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                            }}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>

                    {selected?.desc && (
                      <div style={{ fontSize: 10.5, color: 'var(--tx-3)', marginTop: 6, lineHeight: 1.6 }}>
                        {selected.desc}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>

            {/* 底部：当前配置摘要（方便用户核对） */}
            <div style={{
              padding: '10px 20px', borderTop: '1px solid var(--bdr)',
              background: 'var(--bg-1)',
              fontSize: 10.5, color: 'var(--tx-3)', lineHeight: 1.6,
            }}>
              配置已自动保存到本机，分享链接也会带上流派参数。
              当前参数：
              <code style={{ color: 'var(--tx-2)', marginLeft: 4 }}>
                {new URLSearchParams(configToParams(config)).toString() || '默认'}
              </code>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

/** 从当前页面 URL 读取流派参数（无参数返回 null，便于调用方回退到 localStorage） */
export function readConfigFromUrl(): SchoolConfig | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const hasAny = ['bs', 'gys', 'tm', 'tk', 'jk', 'ky', 'tst', 'cs', 'lz', 'lm'].some(k => params.has(k));
  return hasAny ? paramsToConfig(params) : null;
}
