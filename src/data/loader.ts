import type { Dataset, Snapshot, DailyTimeline } from '../types.ts'

interface DataBundle {
  snapshot: Snapshot
  dataset: Dataset
  daily: DailyTimeline | null
}

const decoder = new TextDecoder('utf-8')

export const loadDataBundle = async (): Promise<DataBundle> => {
  const [snapshotRes, namesRes, metaRes, dobRes, dailyRes] = await Promise.all([
    fetch('/data/snapshot.json'),
    fetch('/data/names.bin'),
    fetch('/data/meta.bin'),
    // dob.bin and daily.json power birthdays and the timeline. They're optional:
    // the memorial still works if either is missing, so failures don't throw.
    fetch('/data/dob.bin').catch(() => null),
    fetch('/data/daily.json').catch(() => null)
  ])

  if (!snapshotRes.ok || !namesRes.ok || !metaRes.ok) {
    throw new Error('Memorial data could not be loaded.')
  }

  const snapshot: Snapshot = await snapshotRes.json()
  const namesBuf = new Uint8Array(await namesRes.arrayBuffer())
  const metaBuf = new Uint8Array(await metaRes.arrayBuffer())

  const count = snapshot.count
  const offsetBytes = (count * 2 + 1) * 4
  const offsetView = new DataView(namesBuf.buffer, namesBuf.byteOffset, offsetBytes)
  const offsets = new Uint32Array(count * 2 + 1)
  for (let i = 0; i < offsets.length; i += 1) {
    offsets[i] = offsetView.getUint32(i * 4, true)
  }

  const textStart = offsetBytes
  const sliceAt = ({ slot }: { slot: number }): string => {
    const start = textStart + offsets[slot]
    const end = textStart + offsets[slot + 1]
    return decoder.decode(namesBuf.subarray(start, end))
  }

  const arabicAt = (index: number) => sliceAt({ slot: index * 2 })
  const englishAt = (index: number) => sliceAt({ slot: index * 2 + 1 })

  const ages = metaBuf.subarray(0, count)

  // Date of birth — yyyymmdd per record, little-endian Uint32. Zero-filled if
  // the file is missing so birthday lookups simply find nothing.
  const dob = new Uint32Array(count)
  if (dobRes && dobRes.ok) {
    const dobBuf = new Uint8Array(await dobRes.arrayBuffer())
    const dv = new DataView(dobBuf.buffer, dobBuf.byteOffset, dobBuf.byteLength)
    for (let i = 0; i < count && (i + 1) * 4 <= dobBuf.byteLength; i += 1) {
      dob[i] = dv.getUint32(i * 4, true)
    }
  }

  let daily: DailyTimeline | null = null
  if (dailyRes && dailyRes.ok) {
    try {
      daily = (await dailyRes.json()) as DailyTimeline
    } catch {
      daily = null
    }
  }

  return {
    snapshot,
    daily,
    dataset: {
      count,
      ages: new Uint8Array(ages),
      dob,
      arabicAt,
      englishAt
    }
  }
}
