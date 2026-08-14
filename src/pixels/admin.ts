/**
 * God mode for the pixel canvas.
 *
 * Same page, same tools, same map — moderation is done by painting, not by
 * curling an API. Unlocking swaps the write path from /paint to /admin, which
 * skips the rate limit and unlocks bulk operations.
 *
 * The token lives in sessionStorage only: it dies with the tab, so an unlocked
 * dashboard is never left lying around on a shared machine.
 */

import { convert, decode, DEFAULTS, type ConvertOptions } from './import'

/** Mirrors the shape the admin route reads and writes. */
export interface IpRules {
  enabled: boolean
  burst: number
  cooldown: number
  cidrs: string[]
}

const KEY = 'campusmap.pixels.admin'

/** A converted image floating over the canvas, not yet committed. */
export interface Ghost {
  px: [number, number, number][]
  w: number
  h: number
  x: number
  y: number
}

/** Pixels per admin request. The route caps at 40k; this keeps each POST small
 *  enough to be quick and to fail in a recoverable chunk. */
const COMMIT_BATCH = 4000

export type Tool = 'paint' | 'rect-erase' | 'rect-fill' | 'inspect'

export interface AdminHost {
  /** Repaint the overlay after a bulk change. */
  redraw(): void
  /** Write straight into the local board without going through the queue. */
  setLocal(x: number, y: number, c: number): void
  /** Reload the canvas from the server. */
  reload(): Promise<void>
  status(text: string, tone?: '' | 'warn' | 'bad'): void
  currentColour(): number
  /** Pass `x: -1` to have the page centre it on the current view. */
  setGhost(g: Ghost | null): void
  getGhost(): Ghost | null
}

export class Admin {
  token: string | null = null
  tool: Tool = 'paint'
  private host: AdminHost
  private panel: HTMLElement
  private base: string
  /** Kept so the sliders can re-convert without re-reading the file. */
  private source: ImageData | null = null
  private opts: ConvertOptions = { ...DEFAULTS }

  constructor(host: AdminHost, base: string) {
    this.host = host
    this.base = base
    this.token = sessionStorage.getItem(KEY)

    this.panel = document.createElement('aside')
    this.panel.id = 'px-admin'
    this.panel.hidden = true
    document.body.append(this.panel)
    this.panel.addEventListener('click', (e) => this.onClick(e))
    // `input` rather than `change` so dragging a slider updates continuously.
    this.panel.addEventListener('input', (e) => this.onInput(e))
    this.panel.addEventListener('change', (e) => this.onInput(e))

    // Ctrl+Shift+A, or ?admin in the URL. Deliberately undiscoverable — there
    // is no button for people to find and poke at.
    addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        this.unlocked ? this.lock() : this.promptUnlock()
      }
    })
    if (new URLSearchParams(location.search).has('admin')) this.promptUnlock()
    if (this.unlocked) this.open()
  }

  get unlocked() { return !!this.token }

  private promptUnlock() {
    const t = prompt('Admin token')
    if (!t) return
    this.token = t.trim()
    sessionStorage.setItem(KEY, this.token)
    this.open()
    // Probe, but never re-lock from here. `call` already locks on a real 401;
    // anything else — storage unbound, quota exhausted, a blip — is not a bad
    // token, and treating it as one made the panel appear and vanish again
    // with no way to reach the tools.
    void this.call('stats').then((r) => {
      if (r?.ok) this.host.status(`god mode · ${r.pixels} pixels, ${r.bans} bans`, '')
      else if (this.unlocked) {
        this.host.status(`god mode · ${r?.error ?? 'storage unavailable'}`, 'warn')
      }
    })
  }

  lock() {
    this.token = null
    this.source = null
    this.host.setGhost(null)
    sessionStorage.removeItem(KEY)
    this.panel.hidden = true
    document.body.classList.remove('admin')
    this.tool = 'paint'
    this.host.status('locked', '')
  }

  private open() {
    this.panel.hidden = false
    document.body.classList.add('admin')
    this.render()
  }

  /** Every admin operation goes through one authenticated POST. */
  async call(op: string, extra: Record<string, unknown> = {}): Promise<any> {
    if (!this.token) return null
    try {
      const res = await fetch(`${this.base}api/pixels/admin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ op, ...extra }),
      })
      const data = await res.json()
      if (res.status === 401) { this.host.status('admin token rejected', 'bad'); this.lock() }
      return data
    } catch {
      this.host.status('admin call failed', 'bad')
      return null
    }
  }

  private render(extra = '') {
    this.panel.innerHTML = `
      <div class="ad-head">
        <b>god mode</b>
        <button data-act="lock" title="Lock (Ctrl+Shift+A)">lock</button>
      </div>
      <div class="ad-tools" role="radiogroup" aria-label="Tool">
        ${(['paint', 'rect-erase', 'rect-fill', 'inspect'] as Tool[]).map((t) =>
          `<button data-tool="${t}" aria-checked="${this.tool === t}" role="radio">${
            { paint: 'Paint', 'rect-erase': 'Erase area', 'rect-fill': 'Fill area', inspect: 'Inspect' }[t]
          }</button>`).join('')}
      </div>
      <div class="ad-row">
        <button data-act="stats">Stats</button>
        <button data-act="bans">Bans</button>
        <button data-act="reload">Reload</button>
        <button data-act="clearAll" class="danger">Wipe all</button>
      </div>
      <div class="ad-row">
        <button data-act="import">Import image…</button>
      </div>
      <div class="ad-row">
        <button data-act="iprules">Campus IPs</button>
      </div>
      ${this.source ? this.importControls() : ''}
      <div class="ad-out">${extra}</div>`
  }

  /**
   * Which ranges get the campus budget, and how big it is.
   *
   * Only publicly routable ranges are worth listing: Cloudflare reports the
   * public source address, so an RFC1918 entry can never match anything.
   */
  private ipForm(r: IpRules, note = '') {
    const esc = (s: string) => s.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))
    return `
      <div class="ad-ip">
        <label class="ad-check">
          <input type="checkbox" data-ip="enabled" ${r.enabled ? 'checked' : ''}>
          whitelist on
        </label>
        <label>pixels
          <input type="number" data-ip="burst" min="1" max="100000" value="${r.burst}"></label>
        <label>every (s)
          <input type="number" data-ip="cooldown" min="1" max="86400" value="${r.cooldown}"></label>
        <textarea data-ip="cidrs" rows="5" spellcheck="false"
          aria-label="Whitelisted ranges, one CIDR per line"
          placeholder="one CIDR per line">${esc(r.cidrs.join('\n'))}</textarea>
        <div class="ad-row">
          <button data-act="saveIp" class="go">Save</button>
          <button data-act="closeIp">Close</button>
        </div>
        <div class="ad-meta">${esc(note)}</div>
      </div>`
  }

  /** Live controls for a loaded image. Every change re-converts and repaints
   *  the ghost, so the admin sees the real result rather than a guess. */
  private importControls() {
    const g = this.host.getGhost()
    const metres = g ? `${g.w * 2} × ${g.h * 2} m` : ''
    return `
      <div class="ad-import">
        <label>size <input type="range" data-opt="width" min="8" max="200"
          value="${this.opts.width}"><span>${this.opts.width}</span></label>
        <label>bg cut <input type="range" data-opt="tolerance" min="0" max="140"
          value="${this.opts.tolerance}"><span>${this.opts.tolerance}</span></label>
        <label class="ad-check">
          <input type="checkbox" data-opt="centre" ${this.opts.centre ? 'checked' : ''}>
          crisp (pixel-art source)
        </label>
        <label>backdrop
          <select data-opt="backdrop">
            ${(['drop', 'holes', 'box'] as const).map((v) =>
              `<option value="${v}" ${this.opts.backdrop === v ? 'selected' : ''}>${
                { drop: 'transparent', holes: 'fill gaps', box: 'solid block' }[v]}</option>`).join('')}
          </select>
        </label>
        <div class="ad-meta">${g ? `${g.px.length} px · ${metres} · drag to move` : ''}</div>
        <div class="ad-row">
          <button data-act="place" class="go">Place</button>
          <button data-act="cancel">Cancel</button>
        </div>
      </div>`
  }

  private reconvert() {
    if (!this.source) return
    const out = convert(this.source, this.opts)
    const prev = this.host.getGhost()
    this.host.setGhost({
      ...out,
      // Keep the position across re-converts; -1 asks the page to centre it.
      x: prev ? prev.x : -1,
      y: prev ? prev.y : -1,
    })
    this.render()
  }

  private async pickImage() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      this.host.status(`decoding ${file.name}…`, '')
      try {
        this.source = await decode(file)
        this.host.setGhost(null)      // reset position for a new image
        this.opts = { ...DEFAULTS }
        this.reconvert()
        this.host.status('drag to position, then Place', '')
      } catch (err) {
        this.host.status(`could not read that image — ${(err as Error).message}`, 'bad')
      }
    }
    input.click()
  }

  private async commitGhost() {
    const g = this.host.getGhost()
    if (!g) return
    const all: [number, number, number][] = g.px.map(([x, y, c]) => [g.x + x, g.y + y, c])
    let done = 0
    for (let i = 0; i < all.length; i += COMMIT_BATCH) {
      const batch = all.slice(i, i + COMMIT_BATCH)
      const r = await this.call('paint', { pixels: batch })
      if (!r?.ok) {
        this.host.status(`stopped after ${done} pixels — ${r?.error ?? 'failed'}`, 'bad')
        return
      }
      done += batch.length
      this.host.status(`placing… ${done}/${all.length}`, '')
    }
    this.source = null
    this.host.setGhost(null)
    await this.host.reload()
    this.host.status(`placed ${done} pixels`, '')
    this.render()
  }

  /** Called by the page when the ghost has been dragged, to refresh the readout. */
  onGhostMoved() {
    if (this.source) this.render()
  }

  /** Sliders and checkboxes re-convert live. */
  private onInput(e: Event) {
    const el = e.target as HTMLInputElement
    const key = el.dataset.opt as keyof ConvertOptions | undefined
    if (!key) return
    const o = this.opts as unknown as Record<string, unknown>
    if (el.type === 'checkbox') o[key] = el.checked
    else if (el.tagName === 'SELECT') o[key] = el.value
    else o[key] = Number(el.value)
    this.reconvert()
  }

  private async onClick(e: Event) {
    const el = (e.target as HTMLElement).closest('button') as HTMLElement | null
    if (!el) return

    if (el.dataset.act === 'import') { void this.pickImage(); return }
    if (el.dataset.act === 'place') { void this.commitGhost(); return }
    if (el.dataset.act === 'cancel') {
      this.source = null
      this.host.setGhost(null)
      this.render()
      return
    }

    if (el.dataset.tool) {
      this.tool = el.dataset.tool as Tool
      this.render()
      return
    }

    switch (el.dataset.act) {
      case 'lock': this.lock(); break

      case 'iprules': {
        const r = await this.call('iprules')
        if (r?.ok) this.render(this.ipForm(r.rules))
        else this.render(`<code>${r?.error ?? 'could not read ip rules'}</code>`)
        break
      }

      case 'closeIp': this.render(); break

      case 'saveIp': {
        const q = (s: string) => this.panel.querySelector(s) as HTMLInputElement | HTMLTextAreaElement
        const rules: IpRules = {
          enabled: (q('[data-ip="enabled"]') as HTMLInputElement).checked,
          burst: Number(q('[data-ip="burst"]').value),
          cooldown: Number(q('[data-ip="cooldown"]').value),
          cidrs: q('[data-ip="cidrs"]').value.split('\n').map((s) => s.trim()).filter(Boolean),
        }
        const r = await this.call('setIprules', { rules })
        // On rejection re-render what they typed, not what the server still
        // holds — otherwise a typo silently discards the whole edit.
        if (r?.ok) {
          this.render(this.ipForm(r.rules, 'saved'))
          this.host.status(
            `campus ips · ${r.rules.enabled ? 'on' : 'off'} · ${r.rules.burst}/${r.rules.cooldown}s`, '')
        } else {
          this.render(this.ipForm(rules, r?.error ?? 'save failed'))
        }
        break
      }
      case 'stats': {
        const r = await this.call('stats')
        this.render(r ? `<code>${r.pixels} pixels · ${r.chunks} chunks · ${r.bans} bans</code>` : '')
        break
      }
      case 'bans': {
        const r = await this.call('bans')
        const list: string[] = r?.bans ?? []
        this.render(list.length
          ? list.map((id) => `<div class="ad-ban"><code>${id}</code><button data-unban="${id}">unban</button></div>`).join('')
          : '<code>no bans</code>')
        break
      }
      case 'reload':
        await this.host.reload()
        this.host.status('canvas reloaded', '')
        break
      case 'clearAll': {
        // Irreversible and total, so make it deliberate.
        if (!confirm('Erase every user-drawn pixel? The seeded art stays.')) break
        const r = await this.call('clearAll')
        if (r?.ok) { await this.host.reload(); this.host.status(`wiped ${r.chunksDeleted} chunks`, 'warn') }
        break
      }
    }

    if (el.dataset.unban) {
      await this.call('unban', { id: el.dataset.unban })
      ;(this.panel.querySelector('[data-act="bans"]') as HTMLElement)?.click()
    }
    if (el.dataset.ban) {
      await this.call('ban', { id: el.dataset.ban })
      this.host.status(`banned ${el.dataset.ban}`, 'warn')
    }
  }

  /** Bulk apply over a rectangle. Returns false if the op was refused. */
  async applyRect(x0: number, y0: number, x1: number, y1: number): Promise<boolean> {
    const x = Math.min(x0, x1), y = Math.min(y0, y1)
    const w = Math.abs(x1 - x0) + 1, h = Math.abs(y1 - y0) + 1
    const c = this.tool === 'rect-fill' ? this.host.currentColour() : 0
    const r = await this.call(this.tool === 'rect-fill' ? 'fillRect' : 'clearRect', { x, y, w, h, c })
    if (!r?.ok) { this.host.status(r?.error ?? 'rectangle refused', 'bad'); return false }
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) this.host.setLocal(x + dx, y + dy, c)
    this.host.redraw()
    this.host.status(`${this.tool === 'rect-fill' ? 'filled' : 'erased'} ${r.affected} pixels`, '')
    return true
  }

  /** Who painted this pixel, with a one-click ban if we know. */
  async inspect(x: number, y: number) {
    const r = await this.call('who', { x, y })
    const p = r?.painter
    this.render(p
      ? `<code>(${x},${y}) by ${p.id}</code>
         <div class="ad-ban"><span>${new Date(p.at).toLocaleString()}</span>
         <button data-ban="${p.id}" class="danger">ban</button></div>`
      : `<code>(${x},${y}) — no recent painter on record</code>`)
  }

  /** Admin paints bypass the rate limit entirely. */
  async paint(pixels: [number, number, number][]) {
    const r = await this.call('paint', { pixels })
    if (!r?.ok) this.host.status(r?.error ?? 'paint refused', 'bad')
    return !!r?.ok
  }
}
