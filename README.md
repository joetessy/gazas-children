# Gaza's Children

![Gaza's Children starfield](docs/screenshot.png)

An interactive memorial: one star for every child (age < 18) recorded as killed in Gaza. Names appear in Arabic and English as you move across the field.

Data comes from the [Tech For Palestine `killed-in-gaza`](https://github.com/TechForPalestine/palestine-datasets/blob/main/killed-in-gaza.json) dataset.

## Stack

- Vite + TypeScript (no framework)
- Tailwind CSS v4 (via `@tailwindcss/vite`)
- Canvas-rendered starfield with a custom packed binary format for names

## Data pipeline

`scripts/build-dataset.ts` fetches the upstream JSON, filters to records with `age < 18`, and writes three files to `public/data/`:

- `names.bin` — packed Arabic + English name strings with a `Uint32` offset table
- `meta.bin` — per-record age bytes (`0–254`, `255` = unknown)
- `snapshot.json` — `{ date, count, sourceUrl }`

The client (`src/data/loader.ts`) fetches these in parallel, reconstructs the offset table, and exposes `arabicAt(i)` / `englishAt(i)` accessors without decoding every string up front.

## Scripts

```sh
pnpm install
pnpm build-data   # refresh public/data/ from upstream
pnpm dev          # start Vite dev server
pnpm build        # build-data + vite build
pnpm preview      # preview the production build
pnpm typecheck    # tsc --noEmit
```

`pnpm build` runs `build-data` first, so production builds always embed the latest snapshot.

## Layout

```
scripts/build-dataset.ts   # upstream fetch + pack
public/data/               # generated binary + snapshot
src/
  main.ts                  # entry, load → mount
  data/loader.ts           # binary unpacker
  starfield/               # geometry, pour animation, scene
  types.ts                 # shared types
  style.css
```
