// Minimal test harness (no dependencies).
const results = [];
export function test(name, fn) {
  const t0 = Date.now();
  try {
    const note = fn();
    results.push({ name, ok: true, note: note || '', ms: Date.now() - t0 });
  } catch (err) {
    results.push({ name, ok: false, note: String((err && err.message) || err), ms: Date.now() - t0 });
  }
}
export function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label || 'value'}: expected ${expected}, got ${actual}`);
}
export function near(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > tol) throw new Error(`${label || 'value'}: expected ${expected} ±${tol}, got ${actual}`);
}
export function ok(cond, label) {
  if (!cond) throw new Error(label || 'assertion failed');
}
export function report() {
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? '  — ' + r.note : ''}  (${r.ms} ms)`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed;
}
