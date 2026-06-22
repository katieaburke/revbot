/**
 * Date utilities — last business day, US federal holiday detection.
 */

// ── US Federal holidays ───────────────────────────────────────────────────────
// Returns the observed date (moves Sat→Fri, Sun→Mon).

function observedDate(year: number, month: number, day: number): Date {
  const d = new Date(year, month - 1, day)
  const dow = d.getDay() // 0=Sun, 6=Sat
  if (dow === 6) d.setDate(d.getDate() - 1) // Sat → Fri
  if (dow === 0) d.setDate(d.getDate() + 1) // Sun → Mon
  return d
}

/** Nth weekday of a month. e.g. nthWeekday(2024, 1, 1, 3) = 3rd Monday of January 2024 */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  // weekday: 0=Sun..6=Sat
  const d = new Date(year, month - 1, 1)
  let count = 0
  while (true) {
    if (d.getDay() === weekday) {
      count++
      if (count === n) return d
    }
    d.setDate(d.getDate() + 1)
  }
}

/** Last occurrence of a weekday in a month. e.g. lastWeekday(2024, 5, 1) = last Monday of May */
function lastWeekday(year: number, month: number, weekday: number): Date {
  const d = new Date(year, month, 0) // last day of month
  while (d.getDay() !== weekday) d.setDate(d.getDate() - 1)
  return d
}

function toYMD(d: Date): string {
  return d.toISOString().split('T')[0]
}

function usHolidaysForYear(year: number): Set<string> {
  const holidays = [
    observedDate(year, 1, 1),                      // New Year's Day
    nthWeekday(year, 1, 1, 3),                      // MLK Day — 3rd Monday of January
    nthWeekday(year, 2, 1, 3),                      // Presidents' Day — 3rd Monday of February
    lastWeekday(year, 5, 1),                        // Memorial Day — last Monday of May
    observedDate(year, 6, 19),                      // Juneteenth
    observedDate(year, 7, 4),                       // Independence Day
    nthWeekday(year, 9, 1, 1),                      // Labor Day — 1st Monday of September
    nthWeekday(year, 10, 1, 2),                     // Columbus Day — 2nd Monday of October
    observedDate(year, 11, 11),                     // Veterans Day
    nthWeekday(year, 11, 4, 4),                     // Thanksgiving — 4th Thursday of November
    observedDate(year, 12, 25),                     // Christmas
  ]
  return new Set(holidays.map(toYMD))
}

// Cache holidays per year
const holidayCache = new Map<number, Set<string>>()
function isUSFederalHoliday(date: Date): boolean {
  const year = date.getFullYear()
  if (!holidayCache.has(year)) holidayCache.set(year, usHolidaysForYear(year))
  return holidayCache.get(year)!.has(toYMD(date))
}

function isWeekend(date: Date): boolean {
  const dow = date.getDay()
  return dow === 0 || dow === 6
}

/** Returns the last business day (not weekend, not US federal holiday) of the given month. */
export function lastBusinessDayOfMonth(year: number, month: number): Date {
  // Start from the last day of the month, work backwards
  const d = new Date(year, month, 0) // last day of month (month is 1-indexed)
  while (isWeekend(d) || isUSFederalHoliday(d)) {
    d.setDate(d.getDate() - 1)
  }
  return d
}

// ── Month-only phrase detection ───────────────────────────────────────────────

const MONTH_NAMES: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
}

/** Returns { month, year } if the phrase is just a month name (optionally with year), else null. */
export function parseMonthOnly(phrase: string): { month: number; year: number } | null {
  const cleaned = phrase.trim().toLowerCase().replace(/[,]/g, '')

  // "august" or "aug" — assume current or next occurrence
  const singleMonth = MONTH_NAMES[cleaned]
  if (singleMonth !== undefined) {
    const now = new Date()
    let year = now.getFullYear()
    // If the month has already passed this year, use next year
    if (singleMonth < now.getMonth() + 1) year += 1
    return { month: singleMonth, year }
  }

  // "august 2026" or "aug 2026"
  const withYear = cleaned.match(/^([a-z]+)\s+(\d{4})$/)
  if (withYear) {
    const month = MONTH_NAMES[withYear[1]]
    const year = parseInt(withYear[2], 10)
    if (month !== undefined) return { month, year }
  }

  // "q1 2026", "q2", etc. → last business day of last month of quarter
  const quarter = cleaned.match(/^q([1-4])(?:\s+(\d{4}))?$/)
  if (quarter) {
    const q = parseInt(quarter[1], 10)
    const now = new Date()
    const year = quarter[2] ? parseInt(quarter[2], 10) : now.getFullYear()
    const lastMonthOfQuarter = q * 3 // Q1→3, Q2→6, Q3→9, Q4→12
    return { month: lastMonthOfQuarter, year }
  }

  return null
}
