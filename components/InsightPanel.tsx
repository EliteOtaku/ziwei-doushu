'use client';
import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ZiweiChart, Palace } from '@/lib/ziwei/types';
import type { TimeView } from './TimeNav';
import { consumeSSE, readErrorResponse } from '@/lib/ai/sse-client';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  hidden?: boolean; // don't show user bubble for auto/topic messages
}

interface SelectedSiHua {
  starName: string;
  siHua: string;
  view: TimeView;
}

interface InsightPanelProps {
  chart: ZiweiChart;
  selectedPalace?: Palace | null;
  selectedSiHua?: SelectedSiHua | null;
}

const TOPICS = [
  { key: 'overview',     label: '命格' },
  { key: 'love',        label: '感情' },
  { key: 'career',      label: '事业' },
  { key: 'wealth',      label: '财运' },
  { key: 'health',      label: '健康' },
  { key: 'personality', label: '性格' },
] as const;

/**
 * 六个话题的提问。
 *
 * 三条硬约束（都来自实测，改动前请先读 docs/argon-followup.md）：
 *   1. 必须显式给字数上限 —— 该通道忽略 max_tokens，面对不封顶的长输出要求
 *      会只思考不产出正文（实测 90 秒内正文 0 字）。
 *   2. 不能写「引用倪海厦原话」这种无条件祈使句 —— 材料未覆盖时会逼模型编造。
 *      改为「材料有则逐字引用，无则写明（此处无原话可引）」。
 *   3. 分 4 节而不是 5 节，且每节限 2～3 句 —— 原 5 节里「格局 / 本宫分析 / 三方联动」
 *      在紫微斗数中本就同义（格局即由本宫加三方四正决定），会浪费字数配额。
 *
 * 结构说明：系统提示词已把命盘与原话放在用户提问上方（由 --- 分隔），
 * 所以这里统一用「上方【命盘数据】」「上方【可引用的倪师原话】」定位，避免位置歧义。
 */
const TOPIC_PROMPTS: Record<string, string> = {
  overview: `请基于上方【命盘数据】生成命格总览。全文总字数严格控制在 450 字以内，直接按以下 4 个小标题分段输出，每段限 2～3 句话：

**【命格定性与主星】**
点明命宫、身宫所在宫位、主星亮度及已识别格局，概括命主核心气质。若上方【可引用的倪师原话】中有对应主星或格局条文则逐字引用，若无则写明「（此处无原话可引）」并直接据盘论述。

**【三方四正与四化】**
综合财帛宫、官禄宫、迁移宫的星曜庙陷与盘面四化星（科权禄忌）落点，说明先天格局的发力方向与器局高低。

**【当前大限走势】**
查看【当前大限】所行宫位及其三方四正、对宫的本有星曜组合与四化星冲照，指明这十年的核心动向与最需关注的事项。

**【天赋优势与功课】**
总结命盘最大的先天优势，并指出化忌星或落陷煞星所在宫位带来的核心人生功课。`,

  love: `请基于上方【命盘数据】分析感情婚姻运势。全文总字数严格控制在 450 字以内，直接按以下 4 个小标题分段输出，每段限 2～3 句话：

**【夫妻宫与先天感情格】**
点明夫妻宫主星、吉煞星、亮度及四化星，说明命主择偶倾向与先天感情形态（空宫须说明借对宫官禄宫之星且力量打折）。若上方【可引用的倪师原话】中有对应条文则逐字引用，若无则写明「（此处无原话可引）」并直接据盘论述。

**【福德与三方互参】**
依「看夫妻必兼看福德」之法，结合福德宫、迁移宫、命宫的星曜庙陷与四化星，分析命主在亲密关系中的情绪底色与隐性卡点。

**【当前大限感情动向】**
查看【当前大限】所行宫位及其三方四正的本有星曜组合，以及是否逢红鸾、天喜或四化星引动夫妻宫/福德宫，判断这十年的感情走势。

**【感情经营建议】**
针对夫妻宫与福德宫的星曜组合特点，给出 2 条具体可落地的择偶或相处建议。`,

  career: `请基于上方【命盘数据】分析事业发展格局。全文总字数严格控制在 450 字以内，直接按以下 4 个小标题分段输出，每段限 2～3 句话：

**【官禄宫与事业定性】**
点明官禄宫主星、亮度、吉煞星及四化星，判断命主适合的行业属性与工作形态（如公职、企管、专业技术或经商创业）。若上方【可引用的倪师原话】中有对应条文则逐字引用，若无则写明「（此处无原话可引）」并直接据盘论述。

**【命财迁三方联动】**
结合命宫、财帛宫、迁移宫的星曜组合与已识别格局，分析事业发展的外部际遇（迁移宫）与变现能力（财帛宫）。

**【当前大限事业运】**
查看【当前大限】所行宫位及其三方四正、对宫的本有星曜庙陷与四化星落点，点明这十年事业宜守成深耕还是主动开拓。

**【事业进阶策略】**
依据盘面优势星曜与化忌星/煞星落点，给出 2 条具体的职业选择或做事方法建议。`,

  wealth: `请基于上方【命盘数据】分析财运与资产格局。全文总字数严格控制在 450 字以内，直接按以下 4 个小标题分段输出，每段限 2～3 句话：

**【财帛宫与求财模式】**
点明财帛宫主星、亮度、禄存及四化星，定性命主的求财方式（正财稳健型、专业技艺型或偏财开创型）。若上方【可引用的倪师原话】中有对应条文则逐字引用，若无则写明「（此处无原话可引）」并直接据盘论述。

**【田宅财库与官禄互参】**
结合田宅宫（藏财之库）及福德宫、官禄宫的星曜庙陷与四化星，判断命主聚财守财能力与置业根基。

**【当前大限财运走势】**
查看【当前大限】所行宫位及其三方四正的本有星曜组合与四化星冲照，分析当前十年的进财契机与破财防线。

**【守财与配置建议】**
针对盘面财帛宫与田宅宫的吉凶星分布，给出 2 条具体的财务管理与风险防范建议。`,

  // 注意：刻意不要求模型说明星曜「五行属性」——
  // formatChart() 不输出星曜五行，那会让模型只能靠世界知识补，违反盘面唯一性。
  health: `请基于上方【命盘数据】分析健康疾厄方向。全文总字数严格控制在 450 字以内，直接按以下 4 个小标题分段输出，每段限 2～3 句话：

**【疾厄宫主星与先天体质】**
点明疾厄宫主星、吉煞星与亮度，指出先天较需留意养护的脏腑方向。若上方【可引用的倪师原话】中有对应疾厄或星曜条文则逐字引用，若无则写明「（此处无原话可引）」并直接据盘论述。

**【命福互参与化忌落点】**
结合命宫、福德宫及盘面化忌星、六煞星所在宫位，分析情绪压力、作息习惯对身体的联动影响。

**【当前大限健康留意点】**
查看【当前大限】所行宫位及其对宫的本有煞星与化忌星分布，指出当前十年最需留意的健康隐患方向。

**【日常养护建议】**
给出 2 条针对性的作息或养生调理建议，并在段末注明「以上仅为命理留意方向，具体健康状况请以临床医生诊断为准」。`,

  personality: `请基于上方【命盘数据】分析性格特质与人际模式。全文总字数严格控制在 450 字以内，直接按以下 4 个小标题分段输出，每段限 2～3 句话：

**【命身主星与核心心性】**
点明命宫与身宫的主星、亮度及四化星，剖析命主外显行事风格与内在本质性格（含命身同宫或异宫的先后天变化）。若上方【可引用的倪师原话】中有对应条文则逐字引用，若无则写明「（此处无原话可引）」并直接据盘论述。

**【福德与三方精神底色】**
结合福德宫（思想与抗压底色）及财、官、迁三方星曜，说明命主的思维习惯、决策魄力与内在执念。

**【迁移与仆役人际模式】**
结合迁移宫（对外形象与际遇）及仆役/交友宫、兄弟宫的星曜组合，分析命主在人际合作中的得失特点。

**【性格盲区与修心课题】**
指出命盘中煞星、落陷星或化忌星带来的性格盲点，给出 2 条具体的人际交往与修心建议。`,
};

const PALACE_ROLES: Record<string, string> = {
  '命宫':   '自我、性格、先天格局',
  '兄弟宫': '兄弟关系、合伙人',
  '夫妻宫': '感情关系、婚姻状态',
  '子女宫': '子女缘分、下属关系',
  '财帛宫': '财运来源、收入方式',
  '疾厄宫': '身体健康、意外',
  '迁移宫': '外出机遇、人际格局',
  '交友宫': '朋友圈、贵人、小人',
  '官禄宫': '事业成就、社会地位',
  '田宅宫': '不动产、家庭环境',
  '福德宫': '精神享受、内心福分',
  '父母宫': '父母关系、文书契约',
};

/** Render AI markdown: **【Title】** → gold header, **bold** → strong */
function AiContent({ text, streaming }: { text: string; streaming?: boolean }) {
  const lines = text.split('\n');
  return (
    <div className="space-y-0.5">
      {lines.map((line, i) => {
        const sectionMatch = line.match(/^\*\*【(.+?)】\*\*$/);
        if (sectionMatch) {
          return (
            <div key={i} className="pt-3 pb-0.5 first:pt-0">
              <span className="text-[11px] font-semibold tracking-wide" style={{ color: 'var(--t-gold)' }}>
                【{sectionMatch[1]}】
              </span>
            </div>
          );
        }
        if (line.trim() === '') return <div key={i} className="h-1" />;
        const parts = line.split(/\*\*(.+?)\*\*/);
        return (
          <div key={i} className="text-[11px] leading-relaxed" style={{ color: 'var(--t-text2)' }}>
            {parts.map((part, j) =>
              j % 2 === 0
                ? part
                : <strong key={j} className="font-medium" style={{ color: 'var(--t-text)' }}>{part}</strong>
            )}
          </div>
        );
      })}
      {streaming && (
        <span
          className="inline-block w-1.5 h-3 ml-0.5 animate-pulse rounded-sm align-middle"
          style={{ background: 'var(--t-gold)', opacity: 0.6 }}
        />
      )}
    </div>
  );
}

export default function InsightPanel({ chart, selectedPalace, selectedSiHua }: InsightPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeTopic, setActiveTopic] = useState<string>('overview');
  /**
   * 已等待秒数。思考型模型（如免费 GLM 通道）首段正文要 30-60 秒，
   * 这期间面板里只有一条空的 assistant 消息 —— 看起来就像「这里什么都没有」。
   * 用它渲染明确的等待状态，否则用户会以为 AI 功能不存在。
   */
  const [waitSecs, setWaitSecs] = useState(0);
  const messagesRef = useRef<Message[]>([]); // always-current copy for closures
  const loadingRef = useRef(false);
  const autoLoaded = useRef(false);
  const lastPalaceBranch = useRef<number | undefined>(undefined);
  const lastSiHuaKey = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep refs in sync
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { loadingRef.current = loading; }, [loading]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // 是否正在等第一段正文（最后一条是空的 assistant 消息且仍在加载）
  const lastMsg = messages[messages.length - 1];
  const waitingFirstToken = loading && lastMsg?.role === 'assistant' && !lastMsg.content;

  // 计时器：只在等待首字期间跑，出字后自动停
  useEffect(() => {
    if (!waitingFirstToken) {
      setWaitSecs(0);
      return;
    }
    const started = Date.now();
    const t = setInterval(() => setWaitSecs(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [waitingFirstToken]);

  // Auto-generate 命格总览 on mount
  useEffect(() => {
    if (autoLoaded.current) return;
    autoLoaded.current = true;
    sendMessage(TOPIC_PROMPTS.overview, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Inject palace analysis when palace selected
  useEffect(() => {
    if (!selectedPalace || selectedPalace.branch === lastPalaceBranch.current) return;
    lastPalaceBranch.current = selectedPalace.branch;

    const majorStars = selectedPalace.stars.filter(s => s.type === 'major');
    const starDesc = majorStars.length > 0
      ? majorStars.map(s => `${s.name}${s.siHua ? '化' + s.siHua : ''}`).join('、')
      : '空宫（借对宫）';
    const role = PALACE_ROLES[selectedPalace.name] ?? '';

    const prompt = `请重点分析【${selectedPalace.name}】（主管：${role}），该宫主星为${starDesc}，按以下结构输出：

**【宫位定性】**
${selectedPalace.name}在命盘中的意义，以及这种星曜配置的整体判断。

**【主星解读】**
主星在此宫的倪海厦体系解读，引用具体观点。

**【三方四正联动】**
三方四正宫位对此宫的影响。

**【实际建议】**
基于此宫的具体建议。`;

    sendMessage(prompt, true);
  }, [selectedPalace]); // eslint-disable-line react-hooks/exhaustive-deps

  // 注入四化飞化分析
  useEffect(() => {
    if (!selectedSiHua) return;
    const key = `${selectedSiHua.starName}-${selectedSiHua.siHua}-${selectedSiHua.view}`;
    if (key === lastSiHuaKey.current) return;
    lastSiHuaKey.current = key;

    // 找出该星所在宫位
    const palaceOfStar = chart.palaces.find(p =>
      p.stars.some(s => s.name === selectedSiHua.starName)
    );
    const palaceName = palaceOfStar?.name ?? '未知宫位';
    const viewLabel = selectedSiHua.view === 'daxian' ? '大限' : '流年';

    const prompt = `请分析【${viewLabel}${selectedSiHua.starName}化${selectedSiHua.siHua}】的飞化影响，按以下结构输出：

**【化${selectedSiHua.siHua}基本含义】**
化${selectedSiHua.siHua}在倪海厦体系中的核心含义，以及${selectedSiHua.starName}化${selectedSiHua.siHua}的特殊含义。

**【落宫影响】**
${selectedSiHua.starName}化${selectedSiHua.siHua}落在【${palaceName}】，该宫主管的领域受到何种影响，倪师如何解读。

**【三方四正飞化路径】**
化${selectedSiHua.siHua}入${palaceName}后，对其三方四正（对宫、两个三合宫）的联动影响。

**【当前运势影响】**
在${viewLabel}时间维度下，此化${selectedSiHua.siHua}对命主近期运势的具体影响。

**【实际建议】**
基于此四化的具体可操作建议。`;

    sendMessage(prompt, true);
  }, [selectedSiHua]); // eslint-disable-line react-hooks/exhaustive-deps

  const streamResponse = async (apiMessages: { role: 'user' | 'assistant'; content: string }[]) => {
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

    let assistantText = '';
    const appendText = (delta: string) => {
      assistantText += delta;
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: assistantText };
        return updated;
      });
    };
    const appendError = (message: string) => {
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: assistantText ? `${assistantText}\n\n⚠️ ${message}` : `⚠️ ${message}`,
        };
        return updated;
      });
    };

    try {
      const res = await fetch('/api/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chart, messages: apiMessages }),
      });

      if (res.status === 404) {
        appendError('接口不存在（/api/interpret 未实现）。排盘本身不需要任何 API Key。');
        return;
      }
      if (!res.ok) {
        const err = await readErrorResponse(res);
        appendError(err.message);
        return;
      }

      await consumeSSE(res, {
        onDelta: appendText,
        onError: err => appendError(err.message),
      });
    } catch (e) {
      appendError(e instanceof Error ? `网络请求失败：${e.message}` : '解读失败，请稍后重试。');
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  };

  const sendMessage = (text: string, hidden = false) => {
    if (!text.trim() || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    const userMsg: Message = { role: 'user', content: text, hidden };
    // Capture current messages synchronously via ref (avoids stale closure)
    const apiMessages = [...messagesRef.current, userMsg].map(m => ({
      role: m.role,
      content: m.content,
    }));

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    streamResponse(apiMessages);
  };

  const handleTopicClick = (topicKey: string) => {
    if (loadingRef.current) return;
    setActiveTopic(topicKey);
    sendMessage(TOPIC_PROMPTS[topicKey], true);
  };

  const handleSend = () => {
    sendMessage(input);
  };

  return (
    <div className="flex flex-col h-full rounded-xl overflow-hidden card-glass">

      {/* ── Topic buttons ── */}
      <div className="flex-shrink-0 px-2 pt-2.5 pb-2" style={{ borderBottom: '1px solid var(--t-border)' }}>
        <div className="grid grid-cols-6 gap-1">
          {TOPICS.map(t => {
            const isActive = activeTopic === t.key;
            return (
              <button
                key={t.key}
                onClick={() => handleTopicClick(t.key)}
                disabled={loading}
                className="py-1.5 text-[10px] font-medium rounded-lg transition-all duration-150 disabled:opacity-40"
                style={{
                  background: isActive ? 'rgba(212,168,67,0.12)' : 'transparent',
                  border: `1px solid ${isActive ? 'rgba(212,168,67,0.3)' : 'var(--t-border)'}`,
                  color: isActive ? 'var(--t-gold)' : 'var(--t-faint)',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Messages ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">

        {/* Loading state before first message */}
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-4xl mb-3" style={{ color: 'var(--t-gold)', opacity: 0.1 }}>✦</div>
            <p className="text-[10px] animate-pulse" style={{ color: 'var(--t-faint)' }}>命格解读生成中…</p>
          </div>
        )}

        <AnimatePresence initial={false}>
          {messages.map((msg, i) => {
            if (msg.role === 'user' && msg.hidden) return null;

            if (msg.role === 'user') {
              return (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex justify-end"
                >
                  <div
                    className="max-w-[85%] rounded-xl px-3 py-2 text-[11px]"
                    style={{
                      background: 'rgba(212,168,67,0.08)',
                      border: '1px solid rgba(212,168,67,0.18)',
                      color: 'var(--t-gold)',
                    }}
                  >
                    {msg.content}
                  </div>
                </motion.div>
              );
            }

            // Assistant message
            const isLastMsg = i === messages.length - 1;
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <div
                  className="text-[9px] tracking-widest mb-2 flex items-center gap-1.5"
                  style={{ color: 'var(--t-faint)' }}
                >
                  <span style={{ color: 'var(--t-gold)', opacity: 0.4 }}>✦</span>
                  命理解读
                </div>
                {isLastMsg && loading && !msg.content ? (
                  // 首字之前的等待态：必须给出可见反馈，否则面板看起来是空的
                  <div className="flex flex-col gap-2 py-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
                        style={{ background: 'var(--t-gold)', opacity: 0.7 }}
                      />
                      <span className="text-[11px]" style={{ color: 'var(--t-text2)' }}>
                        AI 正在思考并撰写…
                        {waitSecs > 0 && ` 已 ${waitSecs} 秒`}
                      </span>
                    </div>
                    <p className="text-[10px] leading-relaxed" style={{ color: 'var(--t-faint)' }}>
                      当前通道模型较慢，通常需要 30–60 秒才开始出字，请稍候。
                      {waitSecs > 100 && ' 若超过 2 分钟仍无内容，会自动提示失败原因。'}
                    </p>
                  </div>
                ) : (
                  <AiContent text={msg.content} streaming={loading && isLastMsg} />
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* ── Input ── */}
      <div className="flex-shrink-0 px-3 pb-3 pt-2" style={{ borderTop: '1px solid var(--t-border)' }}>
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder="继续追问，如：今年适合换工作吗？"
            disabled={loading}
            className="flex-1 rounded-lg px-3 py-2 text-[11px] focus:outline-none transition-colors"
            style={{
              background: 'var(--t-card)',
              border: '1px solid var(--t-border)',
              color: 'var(--t-text)',
            }}
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="px-3 py-2 rounded-lg text-[11px] font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              background: 'rgba(212,168,67,0.15)',
              border: '1px solid rgba(212,168,67,0.25)',
              color: 'var(--t-gold)',
            }}
          >
            {loading ? '…' : '追问'}
          </button>
        </div>
      </div>

    </div>
  );
}
