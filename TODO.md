# TODO — datasets with no public source yet

Ground rule for this repo: **ship real data or ship nothing.** Every dataset below
was deliberately left out rather than filled with plausible-looking invented rows.
Each one has a place to plug into once a real source exists.

## Blocked on a source

| Dataset | Wanted for | Why it's not here |
|---|---|---|
| **Clubs & societies** | `club ctf`, `club robotics` | `students.iitk.ac.in` (linked from the Gymkhana page) is **NXDOMAIN** — the host does not resolve publicly. `iitk.ac.in/students-gymkhana` lists only the 7 councils, not individual clubs. Need a live club roster, or scrape each club's own site. |
| **Courses & timetable** | `PH101`, `L20 now` | Pingala (`pingala.iitk.ac.in`) is login-walled and has no public API. DOAA publishes no machine-readable course schedule; every URL guessed returned 404. Needs either an authenticated Pingala export or a per-semester CSV drop. |
| **Notices** | `notices`, deadline search | No public notice feed found on `iitk.ac.in`. Would need the DOAA/DOSA notice board scraped, if it is public at all. |
| **Bus / shuttle timings** | `bus airport`, `bus station` | Circulated as PDFs by the transport office; nothing machine-readable found. A hand-typed table is fine here **as long as it is transcribed from a real circular** and cites it. |
| **Lost & found** | `lost airpods` | Inherently a live board, not a checked-in file. Wants a small backend or a form-backed sheet. Do not commit a static list. |

## How to add one

1. Add a fetcher to `scripts/fetch-web.mjs` under `TASKS`, writing to `data/live/<name>.json`.
   Include `_source` (the URL) and `_fetched` (ISO date) in the output.
2. Merge it into the payload in `scripts/build-data.mjs`.
3. Register it as a search domain in `src/search/index.ts`.

For anything hand-typed, put it in `data/curated/` with an `anchor` naming a real
OSM feature (never raw coordinates), and cite where the numbers came from.

## Better than any of the above

Most of the physical stuff — printers, vending machines, water coolers, cycle
stands, opening hours, wheelchair access — belongs in **OpenStreetMap** itself.
Map it once there and this app picks it up on the next `npm run fetch`, along with
every other OSM consumer. `data/curated/places.json` is only for things OSM will
not accept.
