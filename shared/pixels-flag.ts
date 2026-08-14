/**
 * One switch for the whole pixel canvas: the page, the link to it from the map,
 * and the API behind it.
 *
 * Everything under `functions/` deploys whether or not the page is built, so
 * gating only the UI left `/api/pixels/*` live and scriptable by anyone who
 * found it — the canvas looked gone while still being paintable by curl. Both
 * sides read this constant, so taking it down is a one-line change that cannot
 * leave half of it exposed.
 *
 * Two overrides, both deliberate:
 *   - `PIXELS=1` in the build environment forces the page on while this is
 *     `false`, so the canvas can still be worked on locally.
 *   - a `PIXELS_ENABLED` variable on the Pages project ("0" or "1") wins over
 *     this constant at runtime, so the API can be killed from the dashboard
 *     without waiting for a deploy.
 */
export const PIXELS_ENABLED = true
