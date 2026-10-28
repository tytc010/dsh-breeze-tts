// dsh-breeze-tts —— 把 Breeze TTS 桥接搬进 DSH 进程
//
// 作用：
//   1) 在 127.0.0.1:9880 上提供 GET /tts?text=… ，返回 24 kHz WAV（Aurabot 的「通用 TTS」直接用）
//   2) 提供 /breeze/api/* 给后续面板用（状态、音色列表、切换音色）
//   3) 随 DSH 启停，不需要独立进程，也不需要桌面开关
//
// 合成协议：Breeze 走 WebSocket /ws/generate，收 PCM16 分片，这里封成 WAV。

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

export const name = 'breeze-tts'
export const inject = ['webServer']

const DEFAULTS = {
  enabled: true,
  port: 9880,
  voiceId: '',
  mode: 'design',
  instruction: '',
  prewarm: true,
  firstCallTimeoutMs: 110000,
  timeoutMs: 90000,
  // 提速：cfg_scale 4.0 会让模型跑两遍（有/无条件各一次），1.0 省掉一半
  cfgScale: 4,
  // 缩短语音条后不需要 1500，600 足够 30 字
  maxNewTokens: 600,
  // 同文本缓存：重复句子直接回放
  cacheSize: 300,
  cacheMaxBytes: 60 * 1024 * 1024
}

function dshHome() {
  const env = (process.env.DSH_HOME || '').trim()
  return env || join(homedir(), '.dsh')
}

function dataDir() {
  return join(dshHome(), 'plugins-data', 'breeze-tts')
}

function configPath() {
  return join(dataDir(), 'config.json')
}

function loadConfig() {
  try {
    const raw = readFileSync(configPath(), 'utf8').replace(/^\uFEFF/, '')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

function saveConfig(cfg) {
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8')
}

// ---------------------------------------------------------------- 后端发现

function desktopLogPath() {
  return join(process.env.APPDATA || '', 'T8star-Aix Voice Studio', 'logs', 'desktop.log')
}

function portFromDesktopLog() {
  const p = desktopLogPath()
  if (!existsSync(p)) return 0
  try {
    const text = readFileSync(p, 'utf8')
    const m = [...text.matchAll(/本地服务已就绪：http:\/\/127\.0\.0\.1:(\d+)/g)]
    return m.length ? Number(m[m.length - 1][1]) || 0 : 0
  } catch {
    return 0
  }
}

function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch {
      resolve('')
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      resolve(out)
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('error', () => { clearTimeout(timer); resolve('') })
    child.on('close', () => { clearTimeout(timer); resolve(out) })
  })
}

async function backendHealthy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

async function portFromProcesses() {
  const list = await run('tasklist', ['/FI', 'IMAGENAME eq python.exe', '/FO', 'CSV', '/NH'])
  const pids = new Set()
  for (const line of list.split(/\r?\n/)) {
    const m = line.match(/^"[^"]+","(\d+)"/)
    if (m) pids.add(m[1])
  }
  if (!pids.size) return 0
  const netstat = await run('netstat', ['-ano', '-p', 'tcp'])
  for (const line of netstat.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
    if (m && pids.has(m[2]) && (await backendHealthy(Number(m[1])))) return Number(m[1])
  }
  return 0
}

let cached = { port: 0, at: 0 }

async function discover(force = false) {
  if (!force && cached.port && Date.now() - cached.at < 15000 && (await backendHealthy(cached.port))) {
    return cached.port
  }
  const fromLog = portFromDesktopLog()
  if (fromLog && (await backendHealthy(fromLog))) {
    cached = { port: fromLog, at: Date.now() }
    return fromLog
  }
  const fromProc = await portFromProcesses()
  cached = { port: fromProc, at: Date.now() }
  return fromProc
}

// ---------------------------------------------------------------- 工具

function pcmToWav(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export function createBridge(config, log = () => {}) {
  let cfg = { ...DEFAULTS, ...(config || {}) }
  const logFile = join(dataDir(), 'bridge.log')
  let modelLoaded = false
  let chain = Promise.resolve()

  const writeLog = (text) => {
    const line = `[${new Date().toISOString()}] ${text}\n`
    try {
      mkdirSync(dataDir(), { recursive: true })
      if (existsSync(logFile) && statSync(logFile).size > 4 * 1024 * 1024) {
        renameSync(logFile, join(dataDir(), `bridge-${Date.now()}.log`))
      }
      appendFileSync(logFile, line, 'utf8')
    } catch {}
    log(line.trim())
  }

  async function prewarm(port) {
    if (modelLoaded || !cfg.prewarm) return
    try {
      const st = await fetch(`http://127.0.0.1:${port}/api/runtime`, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.json()).catch(() => null)
      if (st && st.loaded) {
        modelLoaded = true
        return
      }
      const started = Date.now()
      const r = await fetch(`http://127.0.0.1:${port}/api/runtime/load`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fast_all: false, max_new_tokens: 1500 }),
        signal: AbortSignal.timeout(180000)
      })
      modelLoaded = r.ok
      writeLog(`预加载${r.ok ? '完成' : '失败'}，${((Date.now() - started) / 1000).toFixed(1)} 秒`)
    } catch (e) {
      writeLog('预加载失败：' + e.message)
    }
  }

  async function synthesize({ text, voiceId, instruction, mode, cfgScale, maxNewTokens }) {
    const port = await discover()
    if (!port) {
      const err = new Error('Breeze 后端没在运行（先打开 T8star-Aix Voice Studio）')
      err.status = 503
      throw err
    }
    const payload = {
      text,
      mode: mode || cfg.mode || 'design',
      instruction: instruction || cfg.instruction || '',
      voice_id: voiceId || cfg.voiceId || '',
      cfg_scale: Number(cfgScale || cfg.cfgScale || 4),
      max_new_tokens: Number(maxNewTokens || cfg.maxNewTokens || 600),
      stream_audio: true
    }
    const timeoutMs = modelLoaded ? cfg.timeoutMs : cfg.firstCallTimeoutMs
    const started = Date.now()

    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/generate`)
      ws.binaryType = 'arraybuffer'
      const chunks = []
      let sampleRate = 24000
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { ws.close() } catch {}
        const e = new Error(`合成超时（${Math.round(timeoutMs / 1000)} 秒）`)
        e.status = 504
        reject(e)
      }, timeoutMs)
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { ws.close() } catch {}
        fn(value)
      }
      ws.addEventListener('open', () => {
        try { ws.send(JSON.stringify(payload)) } catch (e) { finish(reject, e) }
      })
      ws.addEventListener('message', (event) => {
        const data = event.data
        if (typeof data === 'string') {
          let msg
          try { msg = JSON.parse(data) } catch { return }
          if (msg.type === 'start') {
            sampleRate = Number(msg.sample_rate) || 24000
            modelLoaded = true
          } else if (msg.type === 'complete') {
            const pcm = Buffer.concat(chunks)
            if (pcm.length < 800) return finish(reject, new Error('返回音频过短'))
            writeLog(`合成 ${text.length} 字 → ${(pcm.length / 1024).toFixed(0)} KB，耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`)
            finish(resolve, { pcm, sampleRate })
          } else if (msg.type === 'error') {
            finish(reject, new Error(msg.message || '合成失败'))
          } else if (msg.type === 'cancelled') {
            finish(reject, new Error('合成被取消'))
          }
        } else {
          chunks.push(Buffer.from(data))
        }
      })
      ws.addEventListener('error', () => finish(reject, new Error('连不上 Breeze 合成接口')))
      ws.addEventListener('close', () => {
        if (settled) return
        const pcm = Buffer.concat(chunks)
        if (pcm.length >= 800) finish(resolve, { pcm, sampleRate })
        else finish(reject, new Error('连接关闭且没有音频'))
      })
    })
  }

  // ---- 同文本缓存（LRU，按 text+音色+参数）----
  const cache = new Map()
  const cacheOrder = []
  let cacheBytes = 0
  let cacheHits = 0
  let cacheMisses = 0

  function cacheGet(key) {
    const hit = cache.get(key)
    if (!hit) return null
    const idx = cacheOrder.indexOf(key)
    if (idx >= 0) { cacheOrder.splice(idx, 1); cacheOrder.push(key) }
    return hit
  }

  function cachePut(key, buf) {
    if (!cfg.cacheSize || cfg.cacheSize <= 0) return
    if (cache.has(key)) return
    cache.set(key, buf)
    cacheOrder.push(key)
    cacheBytes += buf.length
    while (cacheOrder.length > cfg.cacheSize || cacheBytes > cfg.cacheMaxBytes) {
      const old = cacheOrder.shift()
      const b = cache.get(old)
      if (b) cacheBytes -= b.length
      cache.delete(old)
    }
  }

  const enqueue = (task) => {
    const next = chain.then(task, task)
    chain = next.catch(() => {})
    return next
  }

  function json(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }

  async function handler(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${cfg.port}`)
    const p = url.pathname

    if (p === '/health' || p === '/breeze/api/health') {
      const port = await discover()
      return json(res, port ? 200 : 503, {
        ok: Boolean(port),
        backend: port ? `127.0.0.1:${port}` : null,
        modelLoaded,
        voiceId: cfg.voiceId || null,
        mode: cfg.mode,
        cfgScale: cfg.cfgScale,
        maxNewTokens: cfg.maxNewTokens,
        cache: { entries: cache.size, bytes: cacheBytes, hits: cacheHits, misses: cacheMisses }
      })
    }

    if (p === '/breeze/api/voices') {
      const port = await discover()
      if (!port) return json(res, 503, { ok: false, message: 'Breeze 没在运行' })
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/voices`, { signal: AbortSignal.timeout(8000) })
        const data = await r.json()
        return json(res, 200, { ok: true, current: cfg.voiceId || '', voices: data.voices || [] })
      } catch (e) {
        return json(res, 502, { ok: false, message: e.message })
      }
    }

    if (p === '/breeze/api/config') {
      if (req.method === 'POST') {
        let body = ''
        for await (const chunk of req) body += chunk
        try {
          const patch = JSON.parse(body || '{}')
          if (typeof patch.voiceId === 'string') cfg.voiceId = patch.voiceId
          if (typeof patch.mode === 'string') cfg.mode = patch.mode
          if (typeof patch.instruction === 'string') cfg.instruction = patch.instruction
          if (Number.isFinite(Number(patch.cfgScale))) cfg.cfgScale = Number(patch.cfgScale)
          if (Number.isFinite(Number(patch.maxNewTokens))) cfg.maxNewTokens = Number(patch.maxNewTokens)
          saveConfig(cfg)
          writeLog(`配置更新 voice=${cfg.voiceId || '默认'} mode=${cfg.mode}`)
          return json(res, 200, { ok: true, config: cfg })
        } catch (e) {
          return json(res, 400, { ok: false, message: e.message })
        }
      }
      return json(res, 200, { ok: true, config: cfg })
    }

    if (p === '/tts' || p === '/api/tts' || p === '/breeze/api/tts') {
      const text = (url.searchParams.get('text') || '').trim()
      if (!text) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('缺少 text 参数')
      }
      if (text.length > 2000) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('文本太长（上限 2000 字）')
      }
      const voiceId = url.searchParams.get('voice') || url.searchParams.get('voice_id') || ''
      const instruction = url.searchParams.get('instruct') || url.searchParams.get('instruction') || ''
      const mode = url.searchParams.get('mode') || ''
      const cfgScale = Number(url.searchParams.get('cfg') || cfg.cfgScale || 4)
      const maxNewTokens = Number(url.searchParams.get('max_tokens') || cfg.maxNewTokens || 600)
      const key = [voiceId || cfg.voiceId || '', mode || cfg.mode || 'design', instruction || cfg.instruction || '', cfgScale, maxNewTokens, text].join('|')
      try {
        const cached = cacheGet(key)
        if (cached) {
          cacheHits++
          writeLog(`缓存命中（${text.length} 字）`)
          res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': cached.length, 'cache-control': 'no-store' })
          return res.end(cached)
        }
        cacheMisses++
        const { pcm, sampleRate } = await enqueue(() => synthesize({ text, voiceId, instruction, mode, cfgScale, maxNewTokens }))
        const wav = pcmToWav(pcm, sampleRate)
        cachePut(key, wav)
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'cache-control': 'no-store' })
        return res.end(wav)
      } catch (e) {
        writeLog('合成失败：' + e.message)
        res.writeHead(e.status || 500, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end(e.message)
      }
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Breeze TTS：GET /tts?text=…  GET /health  GET /breeze/api/voices')
  }

  const server = createServer((req, res) => {
    handler(req, res).catch((e) => {
      writeLog('处理失败：' + (e?.stack || e))
      try { res.writeHead(500); res.end('内部错误') } catch {}
    })
  })

  return {
    handle(req, res) {
      return handler(req, res)
    },
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(cfg.port, '127.0.0.1', () => {
          server.removeListener('error', reject)
          writeLog(`插件版桥接已启动：http://127.0.0.1:${cfg.port}（voice=${cfg.voiceId || '默认'}，mode=${cfg.mode}）`)
          discover(true).then((port) => { if (port) prewarm(port) }).catch(() => {})
          resolve()
        })
      })
    },
    stop() {
      return new Promise((resolve) => {
        try { server.close(() => resolve()) } catch { resolve() }
      })
    },
    get config() {
      return { ...cfg }
    },
    setConfig(patch) {
      cfg = { ...cfg, ...patch }
      saveConfig(cfg)
      return { ...cfg }
    },
    synthesize
  }
}

let singleton = null

export function apply(ctx, config) {
  try {
    return applyInner(ctx, config)
  } catch (e) {
    try { ctx?.logger?.warn?.(`[dsh-breeze-tts] 初始化失败（已忽略，不影响 DSH）：${e?.message || e}`) } catch {}
    return null
  }
}

function applyInner(ctx, config) {
  if (!ctx || typeof ctx !== 'object') {
    // 允许在 DSH 之外单独测试（node 直接调用 apply(null)）
    const bridge = createBridge(config || {}, (line) => console.log(line))
    bridge.start().catch((e) => console.error('[breeze-tts] 启动失败：', e.message))
    return bridge
  }

  if (singleton) return singleton
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const bridge = createBridge(cfg, (line) => {
    try { ctx.logger?.info?.(`[breeze-tts] ${line}`) } catch {}
  })

  singleton = bridge
  bridge.start().then(
    () => ctx.logger?.info?.(`[dsh-breeze-tts] 就绪 http://127.0.0.1:${cfg.port}`),
    (e) => ctx.logger?.warn?.(`[dsh-breeze-tts] 端口 ${cfg.port} 启动失败：${e.message}`)
  )

  if (ctx.effect) {
    ctx.effect(() => () => { bridge.stop() }, 'breeze-tts: HTTP 桥接')
  }

  // 挂到 DSH 自己的 webServer 上（同源），给面板用；9880 那份留给 Aurabot
  try {
    const webServer = ctx.get?.('webServer') || ctx.webServer
    if (webServer?.register && ctx.effect) {
      for (const path of ['/breeze/api/health', '/breeze/api/voices', '/breeze/api/config', '/breeze/api/tts']) {
        try {
          ctx.effect(
            () => webServer.register({ kind: 'exact', path, handler: (req, res) => bridge.handle(req, res) }),
            `breeze-tts: 路由 ${path}`
          )
        } catch (e) {
          ctx.logger?.warn?.(`[dsh-breeze-tts] 路由 ${path} 挂载失败（忽略）：${e?.message || e}`)
        }
      }
      ctx.logger?.info?.('[dsh-breeze-tts] 面板接口已挂载：/breeze/api/*')
    }
  } catch (e) {
    ctx.logger?.warn?.(`[dsh-breeze-tts] 面板接口挂载跳过：${e?.message || e}`)
  }

  return bridge
}
