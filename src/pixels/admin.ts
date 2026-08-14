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

const KEY = 'campusmap.pixels.admin'

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
}

export class Admin {
  token: string | null = null
  tool: Tool = 'paint'
  private host: AdminHost
  private panel: HTMLElement
  private base: string

  constructor(host: AdminHost, base: string) {
    this.host = host
    this.base = base
    this.token = sessionStorage.getItem(KEY)

    this.panel = document.createElement('aside')
    this.panel.id = 'px-admin'
    this.panel.hidden = true
    document.body.append(this.panel)
    this.panel.addEventListener('click', (e) => this.onClick(e))

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
    void this.call('stats').then((r) => {
      if (r?.ok) this.host.status(`god mode · ${r.pixels} pixels, ${r.bans} bans`, '')
      else { this.host.status('bad admin token', 'bad'); this.lock() }
    })
  }

  lock() {
    this.token = null
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
      <div class="ad-out">${extra}</div>`
  }

  private async onClick(e: Event) {
    const el = (e.target as HTMLElement).closest('button') as HTMLElement | null
    if (!el) return

    if (el.dataset.tool) {
      this.tool = el.dataset.tool as Tool
      this.render()
      return
    }

    switch (el.dataset.act) {
      case 'lock': this.lock(); break
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
