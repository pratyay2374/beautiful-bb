import assert from "node:assert/strict";
import test from "node:test";
import { until } from "./duration.ts";
import { dailyGains, dayBars, recordReading, trackUsage } from "./usage-history.ts";

const HOUR = 60 * 60 * 1000;
const at = (day, hour = 12) => new Date(2026, 10, day, hour).getTime();
const resetsAt = at(25);

function memoryKv() {
  const rows = new Map();
  return {
    rows,
    get: async (key) => structuredClone(rows.get(key)),
    set: async (key, value) => void rows.set(key, structuredClone(value)),
  };
}

const replay = (readings) =>
  readings.reduce((history, [now, usedPercent, resets = resetsAt]) => recordReading(history, { usedPercent, resetsAt: resets }, now), undefined);

test("the first recorded day is partial, so it has no growth of its own", () => {
  const history = replay([[at(19, 9), 15], [at(19, 20), 18]]);
  assert.equal(history.since, "2026-11-19");
  assert.deepEqual(dailyGains(history, at(19, 21)), [null, null, null, null, null, null, null]);
});

test("each day's bar is how far the weekly limit grew that day", () => {
  const history = replay([
    [at(17, 9), 10],
    [at(17, 20), 14],
    [at(18, 10), 14],
    [at(18, 22), 21],
    [at(19, 8), 25],
  ]);
  assert.deepEqual(dailyGains(history, at(19, 9)), [null, null, null, null, null, 7, 4]);
});

test("a day with no reading stays empty and its usage lands on the next reading", () => {
  const history = replay([[at(15), 8], [at(16), 10], [at(18), 16]]);
  assert.deepEqual(dailyGains(history, at(18)), [null, null, null, null, 2, null, 6]);
});

test("a new weekly window counts its usage from zero; reset-time jitter does not", () => {
  const history = replay([
    [at(17), 80],
    [at(18, 10), 90],
    [at(18, 11), 92, resetsAt + 30_000],
    [at(19, 9), 3, resetsAt + 7 * 24 * HOUR],
  ]);
  assert.deepEqual(dailyGains(history, at(19, 10)).slice(-2), [12, 3]);
});

test("history keeps eight days and the graph shows the last seven", () => {
  const history = replay(Array.from({ length: 12 }, (_, i) => [at(8 + i), i * 2]));
  assert.equal(history.days.length, 8);
  assert.equal(history.since, "2026-11-08");
  assert.deepEqual(dailyGains(history, at(19)), [2, 2, 2, 2, 2, 2, 2]);
});

test("each account keeps its own history, and the same account keeps it when it moves into the pool", async () => {
  const kv = memoryKv();
  const local = { id: "claude-code", providerId: "claude-code", accountKey: "anthropic:a", resetsAt: new Date(resetsAt).toISOString() };
  const pooled = { ...local, id: "account-pool:x" };
  const other = { ...local, id: "account-pool:y", accountKey: "anthropic:b" };
  await trackUsage(kv, { ...local, usedPercent: 5 }, at(18));
  await trackUsage(kv, { ...other, usedPercent: 40 }, at(18));
  const moved = await trackUsage(kv, { ...pooled, usedPercent: 8 }, at(19));
  const untouched = await trackUsage(kv, { ...other, usedPercent: 40 }, at(19));
  assert.deepEqual(dailyGains(moved, at(19)).slice(-2), [null, 3]);
  assert.equal(moved.since, "2026-11-18");
  assert.equal(dailyGains(untouched, at(19)).at(-1), 0);
  assert.equal(kv.rows.size, 2);
});

test("unreadable stored history starts over instead of failing the card", async () => {
  const kv = memoryKv();
  kv.rows.set("usage-history:codex:codex", { days: "corrupt" });
  const history = await trackUsage(kv, { id: "codex", providerId: "codex", accountKey: null, usedPercent: 9, resetsAt: new Date(resetsAt).toISOString() }, at(19));
  assert.deepEqual(history, { since: "2026-11-19", days: [{ day: "2026-11-19", usedPercent: 9, resetsAt, gain: 0 }] });
});

const tokens = [10, 20, 30, 40, 50, 60, 70];
const gains = [null, null, null, null, 2, null, 5];

test("a provider's only account shows the provider's tokens as its own, ignoring growth", () => {
  assert.deepEqual(dayBars(gains, tokens, false), tokens.map((amount) => ({ amount, unit: "tokens", shared: false })));
});

test("with several accounts, days with the account's own growth show it and other days fall back to shared tokens", () => {
  const shared = (amount) => ({ amount, unit: "tokens", shared: true });
  assert.deepEqual(dayBars(gains, tokens, true), [
    shared(10), shared(20), shared(30), shared(40),
    { amount: 2, unit: "percent", shared: false },
    shared(60),
    { amount: 5, unit: "percent", shared: false },
  ]);
});

test("days without local token logs stay empty", () => {
  assert.deepEqual(dayBars(gains, [], true).filter(Boolean), [
    { amount: 2, unit: "percent", shared: false },
    { amount: 5, unit: "percent", shared: false },
  ]);
  assert.deepEqual(dayBars(gains, [], false), new Array(7).fill(null));
});

test("reset labels roll over instead of showing 60m or 24h", () => {
  assert.equal(until(30 * 1000), "1m");
  assert.equal(until(59.7 * 60 * 1000), "1h");
  assert.equal(until(23.6 * HOUR), "1d");
  assert.equal(until(47.6 * HOUR), "2d");
  assert.equal(until(24 * HOUR + 23.6 * HOUR), "2d");
  assert.equal(until(2 * 24 * HOUR + 3.2 * HOUR), "2d 3h");
  assert.equal(until(5 * HOUR), "5h");
});
