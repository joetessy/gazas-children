import type { Dataset } from '../types.ts'

export interface SearchResult {
  index: number
  arabic: string
  english: string
}

export interface SearchIndex {
  query: (raw: string, limit?: number) => SearchResult[]
}

// Fold Arabic so spelling variants match: drop harakat/tatweel, unify the
// alef/hamza family, teh-marbuta, and alef-maqsura.
const normalizeArabic = (s: string): string =>
  s
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .trim()

// Lower-case, strip diacritics, collapse punctuation/whitespace.
const normalizeLatin = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const hasArabic = (s: string): boolean => /[؀-ۿ]/.test(s)

export const buildSearchIndex = (dataset: Dataset): SearchIndex => {
  const count = dataset.count
  // Normalise every name once up front — ~18k short strings, quick and cheap.
  const ar: string[] = new Array(count)
  const en: string[] = new Array(count)
  for (let i = 0; i < count; i += 1) {
    ar[i] = normalizeArabic(dataset.arabicAt(i))
    en[i] = normalizeLatin(dataset.englishAt(i))
  }

  const query = (raw: string, limit = 40): SearchResult[] => {
    const trimmed = raw.trim()
    if (trimmed.length < 2) return []

    const hits: { index: number; score: number }[] = []

    if (hasArabic(trimmed)) {
      const q = normalizeArabic(trimmed)
      if (!q) return []
      for (let i = 0; i < count; i += 1) {
        const at = ar[i].indexOf(q)
        if (at >= 0) hits.push({ index: i, score: at === 0 ? 0 : 1 })
      }
    } else {
      const q = normalizeLatin(trimmed)
      if (!q) return []
      const terms = q.split(' ')
      for (let i = 0; i < count; i += 1) {
        const hay = en[i]
        let ok = true
        let score = 0
        for (const term of terms) {
          const at = hay.indexOf(term)
          if (at < 0) {
            ok = false
            break
          }
          // Word-boundary matches rank above mid-word matches.
          score += at === 0 || hay[at - 1] === ' ' ? 0 : 1
        }
        if (ok) hits.push({ index: i, score })
      }
    }

    hits.sort((a, b) => a.score - b.score || a.index - b.index)
    return hits.slice(0, limit).map((h) => ({
      index: h.index,
      arabic: dataset.arabicAt(h.index),
      english: dataset.englishAt(h.index)
    }))
  }

  return { query }
}
