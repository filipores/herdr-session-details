import assert from "node:assert/strict";
import { test } from "node:test";
import { liveStatus, percent, quotaStatus, dateTime, shortDate, resetSummary } from "../mods/session-details/status.js";

const now = new Date(2026, 9, 31, 12).getTime();
const snapshot = { version: 1, pid: 123, updatedAt: now, model: { name: "Test" } };
const terminal = { foreground: { pid: 123 }, labels: { "pi.live-status": JSON.stringify(snapshot) } };

test("metadata belongs to the live foreground process and expires", () => {
  assert.deepEqual(liveStatus(terminal, now), snapshot);
  assert.equal(liveStatus({ ...terminal, foreground: { pid: 456 } }, now), null);
  assert.equal(liveStatus(terminal, now + 76000), null);
  assert.equal(liveStatus(terminal, now - 31000), null);
  assert.equal(liveStatus({ labels: { "pi.live-status": "broken" } }, now), null);
  assert.equal(liveStatus(null, now), null);
  assert.equal(liveStatus({ labels: { "pi.live-status": JSON.stringify({ version: 1, updatedAt: now }) } }, now), null);
});

test("unknown percentages are not displayed as zero; old quotas are hidden", () => {
  assert.equal(percent(null), null);
  assert.equal(percent(undefined), null);
  assert.equal(percent(NaN), null);
  assert.equal(percent(0), 0);
  assert.equal(percent(101), 100);
  assert.equal(quotaStatus({ quota: { fetchedAt: now - 121000 } }, now), null);
  assert.equal(quotaStatus({ quota: { fetchedAt: now, weeklyLeft: 31 } }, now).weeklyLeft, 31);
});

test("compact dates are lowercase English; tooltips retain the exact local time and year", () => {
  const time = new Date(2026, 10, 7, 0, 18).getTime();
  assert.equal(shortDate(time, now), "nov 7");
  assert.equal(dateTime(time), "nov 7, 2026 at 00:18");
  assert.equal(shortDate(new Date(2027, 0, 2).getTime(), now), "jan 2, 2027");
  assert.equal(dateTime(null), "—");
  assert.equal(shortDate(null, now), "—");
});

test("reset summary distinguishes unavailable, zero, expiring and non-expiring credits", () => {
  const time = new Date(2026, 10, 7, 0, 18).getTime();
  assert.deepEqual(resetSummary({ resetCount: 1, firstResetExpiresAt: time }, now), {
    label: "1 reset available", expiry: "expires nov 7",
    detail: "first reset expires nov 7, 2026 at 00:18 (local time)",
  });
  assert.equal(resetSummary(null, now).label, "resets unavailable");
  assert.equal(resetSummary({ resetCount: 0, firstResetExpiresAt: time }, now).expiry, "");
  assert.equal(resetSummary({ resetCount: 0 }, now).label, "0 resets available");
  assert.equal(resetSummary({ resetCount: 2, firstResetExpiresAt: null }, now).expiry, "no expiry");
  assert.equal(resetSummary({ resetCount: 2 }, now).label, "2 resets available");
});
