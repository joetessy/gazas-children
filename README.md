# Gaza's Children

![Gaza's Children starfield](docs/screenshot.png)

An interactive memorial: one star for every child (age < 18) recorded as killed in Gaza. Names appear in Arabic and English as you move across the field.

Data comes from the [Tech For Palestine `killed-in-gaza`](https://github.com/TechForPalestine/palestine-datasets/blob/main/killed-in-gaza.json) dataset.

## Stack

- Vite + TypeScript (no framework)
- Tailwind CSS v4 (via `@tailwindcss/vite`)
- Canvas-rendered starfield with a custom packed binary format for names

## Data pipeline

`scripts/build-dataset.ts` fetches the upstream JSON, filters to records with `age < 18`, and writes to `public/data/`:

- `names.bin` — packed Arabic + English name strings with a `Uint32` offset table
- `meta.bin` — per-record age bytes (`0–254`, `255` = unknown)
- `dob.bin` — per-record date of birth packed as `yyyymmdd` (`Uint32`, `0` = unknown); powers the birthday glow + "would have turned N"
- `daily.json` — reported cumulative children toll over real calendar dates (from the `casualties_daily` series); drives the timeline scrubber
- `snapshot.json` — `{ date, count, sourceUrl }`

The client (`src/data/loader.ts`) fetches these in parallel, reconstructs the offset table, and exposes `arabicAt(i)` / `englishAt(i)` accessors without decoding every string up front.

`scripts/build-og.ts` reads `snapshot.json` and renders `public/og.png` — the social share card with the current count baked in.

## Interaction

The 3D starfield (`src/starfield/3d/`) supports: searching a name (Arabic or English) and flying to that star; shareable per-child permalinks (`#child=<index>`); a warm glow on children whose birthday is today; an age histogram filter; a timeline scrubber that reveals stars in proportion to the real cumulative toll; a hands-free "vigil" tour; and leaving a remembrance "stone" (persisted in `localStorage`).

## Scripts

```sh
pnpm install
pnpm build-data   # refresh public/data/ from upstream
pnpm build-og     # regenerate public/og.png from snapshot.json
pnpm dev          # start Vite dev server
pnpm build        # build-data + build-og + vite build
pnpm preview      # preview the production build
pnpm typecheck    # tsc --noEmit
```

`pnpm build` runs `build-data` then `build-og` first, so production builds always embed the latest snapshot and share card.

## Layout

```
scripts/build-dataset.ts   # upstream fetch + pack (names, ages, dob, daily)
scripts/build-og.ts        # render public/og.png share card
public/data/               # generated binaries + snapshot + daily
src/
  main.ts                  # entry, load → mount
  data/loader.ts           # binary unpacker
  starfield/
    search.ts              # Arabic + Latin name search index
    3d/                    # scene, stars shader, hover, Starfield3D (interaction)
  types.ts                 # shared types
  style.css
```
