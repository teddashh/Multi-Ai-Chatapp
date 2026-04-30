// Astrology helpers — sun-sign derivation from a birth timestamp +
// timezone. Moon and rising require accurate location-based ephemeris
// data so we let users fill them manually rather than computing.

const SIGN_KEYS = [
  'aries',
  'taurus',
  'gemini',
  'cancer',
  'leo',
  'virgo',
  'libra',
  'scorpio',
  'sagittarius',
  'capricorn',
  'aquarius',
  'pisces',
] as const;
export type SignKey = (typeof SIGN_KEYS)[number];

export const SIGN_KEY_SET = new Set<string>(SIGN_KEYS);

// Given month (1-12) and day (1-31) in the *birth* timezone, return the
// Western tropical sun sign. Boundary dates follow the conventional
// astrology table (sources agree to within ±1 day at cusps; we pin to
// a single canonical table).
export function sunSignFromMonthDay(month: number, day: number): SignKey {
  const md = month * 100 + day;
  if (md >= 321 && md <= 419) return 'aries';
  if (md >= 420 && md <= 520) return 'taurus';
  if (md >= 521 && md <= 620) return 'gemini';
  if (md >= 621 && md <= 722) return 'cancer';
  if (md >= 723 && md <= 822) return 'leo';
  if (md >= 823 && md <= 922) return 'virgo';
  if (md >= 923 && md <= 1022) return 'libra';
  if (md >= 1023 && md <= 1121) return 'scorpio';
  if (md >= 1122 && md <= 1221) return 'sagittarius';
  // Capricorn straddles the year boundary
  if (md >= 1222 || md <= 119) return 'capricorn';
  if (md >= 120 && md <= 218) return 'aquarius';
  return 'pisces'; // 219–320
}

// Extract (month, day) of an instant in a specific IANA timezone.
// Used by callers that have a UTC unix timestamp and a stored
// preferred timezone — sun sign is calendar-based so we read the date
// in the user's local birth tz, not UTC.
export function monthDayInTz(
  epochSec: number,
  tz: string,
): { month: number; day: number } {
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      month: '2-digit',
      day: '2-digit',
    });
    const parts = f.formatToParts(new Date(epochSec * 1000));
    let month = 1;
    let day = 1;
    for (const p of parts) {
      if (p.type === 'month') month = parseInt(p.value, 10);
      else if (p.type === 'day') day = parseInt(p.value, 10);
    }
    return { month, day };
  } catch {
    // Bad tz string — fall back to UTC date.
    const d = new Date(epochSec * 1000);
    return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }
}

// Derive sun sign directly from an epoch + tz.
export function sunSignFromEpoch(epochSec: number, tz: string): SignKey {
  const { month, day } = monthDayInTz(epochSec, tz);
  return sunSignFromMonthDay(month, day);
}
