import { formatTime, zoneLabel } from './zones';

const KARACHI = 'Asia/Karachi';

describe('showing a time to the viewer', () => {
  it('W1. same zone: one time; different zones: both, labelled', () => {
    const iso = '2030-01-07T05:00:00.000Z'; // 10:00 in Karachi

    expect(formatTime(iso, KARACHI, KARACHI)).toEqual({ clinic: 'Mon 7 Jan 10:00', viewer: null, text: 'Mon 7 Jan 10:00' });
    expect(formatTime(iso, KARACHI, 'Europe/London').text).toBe(
      'Mon 7 Jan 10:00 clinic time (Karachi) · 05:00 your time (London)',
    );
  });

  it("W2. near midnight the viewer's day is shown when it differs", () => {
    const iso = '2030-01-07T18:30:00.000Z'; // Monday 23:30 in Karachi

    // London: 18:30, still Monday, so no day needed.
    expect(formatTime(iso, KARACHI, 'Europe/London').viewer).toBe('18:30');
    // Auckland (UTC+13 in January): already Tuesday morning.
    expect(formatTime(iso, KARACHI, 'Pacific/Auckland').viewer).toBe('Tue 8 Jan 07:30');
  });

  it("W3. daylight saving in the viewer's zone: London moves an hour, Karachi doesn't", () => {
    // 10:00 Karachi = 05:00 UTC on both days. UK clocks go forward on Sunday 29 March 2026.
    expect(formatTime('2026-03-28T05:00:00.000Z', KARACHI, 'Europe/London').viewer).toBe('05:00'); // GMT
    expect(formatTime('2026-03-30T05:00:00.000Z', KARACHI, 'Europe/London').viewer).toBe('06:00'); // BST
  });

  it('a zone that matches the clinic at that moment shows one time', () => {
    // Asia/Karachi and Asia/Tashkent are both UTC+5 all year.
    expect(formatTime('2030-01-07T05:00:00.000Z', KARACHI, 'Asia/Tashkent').viewer).toBeNull();
  });

  it('labels zones by their city', () => {
    expect(zoneLabel('America/New_York')).toBe('New York');
    expect(zoneLabel('Asia/Karachi')).toBe('Karachi');
  });
});
