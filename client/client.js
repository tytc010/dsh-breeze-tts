// dsh-breeze-tts 客户端半边：侧栏「Breeze 语音」入口 + 音色选择面板
// 配色全部走 DSH 主题变量（--dsw-alias-*），深浅色自动跟随，不再硬编码。

window.__ModuleLoader__.load({
  id: 'dsh-breeze-tts',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    const inject = ['slots']
    const API = '/breeze/api'
    const PANEL_ID = 'breeze'

    // 全部来自 DSH 主题；保留 fallback，主题变量缺失时也不至于不可读
    const C = {
      text: 'var(--dsw-alias-label-primary, #1d1d1f)',
      sub: 'var(--dsw-alias-label-secondary, #6e6e73)',
      tertiary: 'var(--dsw-alias-label-tertiary, #86868b)',
      line: 'var(--dsw-alias-border-l1, #e5e5ea)',
      line2: 'var(--dsw-alias-border-l2, #d2d2d7)',
      card: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      card2: 'var(--dsw-alias-bg-layer-2, #f5f5f7)',
      hover: 'var(--dsw-alias-interactive-bg-hover, #f2f2f7)',
      selBg: 'var(--dsw-alias-interactive-bg-hover-accent, rgba(0,113,227,0.08))',
      accent: 'var(--dsw-alias-brand-primary, #0071e3)',
      btnFill: 'var(--dsw-alias-button-primary-fill, #0071e3)',
      btnHover: 'var(--dsw-alias-button-primary-hover, #0077ed)',
      btnDim: 'var(--dsw-alias-button-primary-dimmed, #d2d2d7)',
      btnText: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      ok: 'var(--dsw-alias-state-success-primary, #1d9a5b)',
      err: 'var(--dsw-alias-state-error-primary, #d70015)',
      font: 'var(--dsh-font-family-ui, inherit)'
    }

    const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`

    const get = (p) =>
      fetch(API + p, { cache: 'no-store' })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, message: '连不上插件：' + e.message }))

    const post = (p, body) =>
      fetch(API + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {})
      })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, message: '连不上插件：' + e.message }))

    function modeLabel(m) {
      return ({ design: '设计', clone: '克隆', direction: '指令' })[m] || m || '设计'
    }

    function BreezeIcon() {
      return h(
        'svg',
        { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' },
        h('path', { d: 'M4 10v4' }),
        h('path', { d: 'M8 6v12' }),
        h('path', { d: 'M12 9v6' }),
        h('path', { d: 'M16 4v16' }),
        h('path', { d: 'M20 10v4' })
      )
    }

    function Pill({ tone, children }) {
      const color = tone === 'ok' ? C.ok : tone === 'err' ? C.err : C.sub
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 9px',
            borderRadius: 999,
            fontSize: 12,
            background: C.card2,
            border: '1px solid ' + C.line,
            color
          }
        },
        h('i', { style: { width: 6, height: 6, borderRadius: 999, background: color, display: 'inline-block' } }),
        children
      )
    }

    function VoiceCard({ voice, isCurrent, selected, onSelect }) {
      const [hover, setHover] = useState(false)
      const tags = (voice.tags || []).join('、')
      const sub = [modeLabel(voice.mode), voice.language || 'auto', tags].filter(Boolean).join(' · ')
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 14px',
            borderRadius: 10,
            border: '1px solid ' + (selected ? C.accent : C.line),
            background: selected ? C.selBg : hover ? C.hover : C.card,
            cursor: 'pointer',
            transition: 'background .12s ease, border-color .12s ease'
          },
          onClick: onSelect,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          role: 'button',
          tabIndex: 0
        },
        h(
          'div',
          {
            style: {
              width: 18,
              height: 18,
              borderRadius: 999,
              flex: 'none',
              border: '1.5px solid ' + (selected ? C.accent : C.line2),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: selected ? C.accent : 'transparent'
            }
          },
          selected ? h('span', { style: { width: 6, height: 6, borderRadius: 999, background: C.btnText } }) : null
        ),
        h(
          'div',
          { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontSize: 14, fontWeight: 600, color: C.text } }, voice.name),
          h('div', { style: { fontSize: 12, color: C.sub, marginTop: 2 } }, sub)
        ),
        isCurrent
          ? h(
              'span',
              {
                style: {
                  fontSize: 11.5,
                  color: C.accent,
                  background: tint(C.accent, 12),
                  padding: '3px 9px',
                  borderRadius: 999,
                  flex: 'none'
                }
              },
              '当前使用'
            )
          : null
      )
    }

    function PrimaryButton({ children, disabled, onClick }) {
      const [hover, setHover] = useState(false)
      return h(
        'button',
        {
          type: 'button',
          disabled,
          onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            border: '1px solid transparent',
            borderRadius: 8,
            padding: '7px 16px',
            fontSize: 13,
            fontWeight: 600,
            fontFamily: C.font,
            color: C.btnText,
            cursor: disabled ? 'default' : 'pointer',
            background: disabled ? C.btnDim : hover ? C.btnHover : C.btnFill,
            transition: 'background .12s ease'
          }
        },
        children
      )
    }

    function GhostButton({ children, onClick }) {
      const [hover, setHover] = useState(false)
      return h(
        'button',
        {
          type: 'button',
          onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            border: '1px solid ' + C.line2,
            borderRadius: 8,
            padding: '7px 14px',
            fontSize: 13,
            fontFamily: C.font,
            background: hover ? C.hover : 'transparent',
            color: C.text,
            cursor: 'pointer',
            transition: 'background .12s ease'
          }
        },
        children
      )
    }

    function BreezePage() {
      const [state, setState] = useState({ loading: true, ok: false, voices: [], current: '', message: '' })
      const [health, setHealth] = useState(null)
      const [selected, setSelected] = useState('')
      const [applying, setApplying] = useState(false)
      const [toast, setToast] = useState(null)

      const reload = useCallback(() => {
        setState((s) => ({ ...s, loading: true }))
        Promise.all([get('/voices'), get('/health')]).then(([v, hl]) => {
          setHealth(hl && hl.ok !== undefined ? hl : null)
          if (!v.ok) {
            setState({ loading: false, ok: false, voices: [], current: '', message: v.message || '读不到音色列表' })
            return
          }
          setState({ loading: false, ok: true, voices: v.voices || [], current: v.current || '', message: '' })
          setSelected((prev) => prev || v.current || (v.voices?.[0]?.id ?? ''))
        })
      }, [])

      useEffect(() => { reload() }, [reload])

      useEffect(() => {
        if (!toast) return
        const t = setTimeout(() => setToast(null), 3200)
        return () => clearTimeout(t)
      }, [toast])

      const apply = () => {
        if (!selected || selected === state.current) return
        setApplying(true)
        post('/config', { voiceId: selected }).then((r) => {
          setApplying(false)
          if (!r.ok) { setToast({ kind: 'err', text: r.message || '应用失败' }); return }
          setState((s) => ({ ...s, current: selected }))
          const name = state.voices.find((v) => v.id === selected)?.name || ''
          setToast({ kind: 'ok', text: '已切换为「' + name + '」，下一句话就是新声音' })
        })
      }

      const wrap = { padding: '20px 24px 32px', maxWidth: 640, margin: '0 auto', color: C.text, fontFamily: C.font }
      const header = h(
        'div',
        { style: { marginBottom: 16 } },
        h('h2', { style: { margin: 0, fontSize: 17, fontWeight: 600 } }, 'Breeze 语音'),
        h('p', { style: { margin: '6px 0 0', fontSize: 12.5, color: C.sub, lineHeight: 1.6 } },
          'Aurabot 在 QQ 里说话时用的音色。音色本身在 Breeze 里编辑，这里只负责挑一个。'),
        h('div', { style: { display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' } },
          h(Pill, { tone: health?.ok ? 'ok' : 'err' }, health?.ok ? 'Breeze 在线' : 'Breeze 未运行'),
          h(Pill, { tone: health?.modelLoaded ? 'ok' : '' }, health?.modelLoaded ? '模型已加载' : '模型未加载'),
          health?.backend ? h(Pill, null, health.backend) : null
        )
      )

      if (state.loading) {
        return h('div', { style: wrap }, header, h('div', { style: { color: C.sub, fontSize: 13 } }, '正在读取音色…'))
      }

      if (!state.ok) {
        return h('div', { style: wrap }, header,
          h('div', { style: { border: '1px solid ' + C.line, borderRadius: 10, background: C.card, padding: '16px 16px' } },
            h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, '没能读到音色'),
            h('div', { style: { fontSize: 12.5, color: C.sub, lineHeight: 1.7 } }, state.message || '先打开 T8star-Aix Voice Studio，再回来刷新。'),
            h('div', { style: { marginTop: 12 } }, h(GhostButton, { onClick: reload }, '重新读取'))
          )
        )
      }

      if (!state.voices.length) {
        return h('div', { style: wrap }, header,
          h('div', { style: { border: '1px solid ' + C.line, borderRadius: 10, background: C.card, padding: '16px 16px' } },
            h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, '音色库还是空的'),
            h('div', { style: { fontSize: 12.5, color: C.sub } }, '先去 Breeze 里建一个音色，回来点刷新。'),
            h('div', { style: { marginTop: 12 } }, h(GhostButton, { onClick: reload }, '刷新'))
          )
        )
      }

      const dirty = selected && selected !== state.current

      return h('div', { style: wrap },
        header,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          state.voices.map((v) =>
            h(VoiceCard, {
              key: v.id,
              voice: v,
              isCurrent: v.id === state.current,
              selected: v.id === selected,
              onSelect: () => setSelected(v.id)
            })
          )
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 } },
          h('div', { style: { flex: 1, fontSize: 12.5, color: C.tertiary } }, '共 ' + state.voices.length + ' 个音色'),
          h(GhostButton, { onClick: reload }, '刷新'),
          h(PrimaryButton, { disabled: !dirty || applying, onClick: apply }, applying ? '应用中…' : '应用此音色')
        ),
        toast
          ? h('div', {
              style: {
                marginTop: 12,
                padding: '8px 12px',
                borderRadius: 8,
                fontSize: 12.5,
                color: toast.kind === 'ok' ? C.ok : C.err,
                background: tint(toast.kind === 'ok' ? C.ok : C.err, 10),
                border: '1px solid ' + tint(toast.kind === 'ok' ? C.ok : C.err, 28)
              }
            }, toast.text)
          : null
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, BreezePage))
      slots.inject('sidebar.panellist', () =>
        slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 22, label: () => 'Breeze 语音' }, BreezeIcon)
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.BreezePage = BreezePage
    exports.BreezeIcon = BreezeIcon
    return module.exports
  }
})
