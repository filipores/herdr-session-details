import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { liveStatus, percent, quotaStatus, dateTime, shortDate, resetSummary, capabilities } from "../mods/session-details/status.js";

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

test("5h expiry is independent of weekly quota and old labels remain compatible", () => {
  const quota = { fetchedAt: now, sessionLeft: 25, sessionResetAt: now, weeklyLeft: 80, weeklyResetAt: now + 3600000 };
  assert.equal(quotaStatus({ quota }, now).sessionLeft, null);
  assert.equal(quotaStatus({ quota }, now).weeklyLeft, 80);
  assert.equal(quotaStatus({ quota }, now - 1).sessionLeft, 25);
  assert.equal(capabilities({ version: 2, capabilities: { weekly: true } }).session, undefined);
  assert.equal(capabilities(snapshot).session, undefined);
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

test("panel renders supported 5h values, hides old/unsupported fields and keeps the footer", async () => {
  function element() {
    const node = { styles: {}, children: [] };
    const builder = new Proxy(node, { get(target, key) {
      if (key in target) return target[key];
      return (...args) => {
        if (key === "when") return args[0] ? args[1](builder) : builder;
        if (key === "child") node.children.push(args[0]);
        else node.styles[key] = args;
        return builder;
      };
    } });
    return builder;
  }
  let value, footer = false;
  const dependencies = {
    "gpui-kit": { View: class {}, div: element, svg: element, image: element },
    "gpui-base": { h_flex: element, v_flex: element },
    "./status.js": { liveStatus, percent, dateTime, quotaStatus, resetSummary, capabilities },
    herdr: { focused: () => ({ terminal: "t1" }), panes: () => [], spaces: () => [],
      terminals: () => [{ address: "t1", foreground: { pid: 123 }, labels: { "herdr.session-details": JSON.stringify(value) } }],
      props: () => ({ footer }), theme: () => ({}), settings: () => ({}), shared: () => null, window: () => ({}), run() {} },
  };
  const mod = new vm.SourceTextModule(await readFile(new URL("../mods/session-details/main.js", import.meta.url), "utf8"));
  await mod.link(name => new vm.SyntheticModule(Object.keys(dependencies[name]), function () {
    for (const [key, item] of Object.entries(dependencies[name])) this.setExport(key, item);
  }));
  await mod.evaluate();
  const view = new mod.namespace.default();
  view.init({}, { timer: { every() {} } });
  const nodes = node => typeof node === "object" ? [node, ...node.children.flatMap(nodes)] : [];
  const text = node => typeof node === "string" ? [node] : node.children.flatMap(text);
  for (const [supported, left, expired, expected] of [[true, 25, false, "25%"], [true, null, false, "—"], [true, 0, false, "0%"], [true, 25, true, "—"], [false, 25, false, null], [undefined, 25, false, null]]) {
    value = { version: 2, client: "claude-code", pid: 123, updatedAt: Date.now(),
      capabilities: { weekly: true, ...(supported === undefined ? {} : { session: supported }) },
      quota: { fetchedAt: Date.now(), sessionLeft: left, sessionResetAt: expired ? 1 : Date.now() + 3600000, weeklyLeft: 80 } };
    const rendered = view.render();
    const metric = nodes(rendered).find(node => node.styles.tooltip?.[0]?.startsWith("5h remaining:"));
    if (expected === null) assert.equal(metric, undefined);
    else {
      assert.deepEqual(text(metric), ["5h\nremaining", expected]);
      assert.equal(metric.styles.accessibility_label[0], metric.styles.tooltip[0]);
    }
    assert.ok(text(rendered).includes("80%"), "weekly allowance stays visible, including old v2 labels");
  }
  footer = true;
  const rendered = view.render();
  assert.ok(text(rendered).includes("this computer"));
  assert.ok(!text(rendered).includes("5h\nremaining"));
});
