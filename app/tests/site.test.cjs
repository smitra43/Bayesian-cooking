// Site checks: node --test app/tests/site.test.cjs
//
// These catch the mistakes that break the page without breaking the engine
// tests: a file listed in index.html that doesn't exist, a script with a
// syntax error, a UI file that uses Chef.something nobody defines, or an
// accidental dependency on the internet.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf8");
const refs = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
const scripts = refs.filter((r) => r.endsWith(".js"));
const uiFiles = scripts.filter((s) => s.startsWith("ui/"));

test("index.html is a complete page", () => {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport"/);
});

test("every file index.html loads exists", () => {
  for (const r of [...refs, "vendor/plotly.min.js"]) assert.ok(fs.existsSync(path.join(APP, r)), `missing ${r}`);
});

test("fonts referenced by fonts.css exist", () => {
  const css = fs.readFileSync(path.join(APP, "vendor/fonts/fonts.css"), "utf8");
  for (const [, f] of css.matchAll(/url\("([^"]+)"\)/g)) assert.ok(fs.existsSync(path.join(APP, "vendor/fonts", f)), `missing font ${f}`);
});

test("nothing is loaded from the internet", () => {
  const files = [html, fs.readFileSync(path.join(APP, "styles.css"), "utf8"), ...scripts.map((s) => fs.readFileSync(path.join(APP, s), "utf8"))];
  for (const text of files) assert.doesNotMatch(text, /(src|href)=["']https?:|@import\s+url\(["']?https?:|fonts\.googleapis|cdn\.jsdelivr|cdnjs/);
});

test("every script parses", () => {
  for (const s of scripts) assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(APP, s), "utf8"), { filename: s }), s);
});

test("the engine loads before the UI, and ui/app.js is last", () => {
  assert.ok(scripts.findIndex((s) => s.startsWith("ui/")) > scripts.findLastIndex((s) => s.startsWith("engine/")));
  assert.equal(scripts[scripts.length - 1], "ui/app.js");
});

test("every Chef.name used by the UI is defined by some UI file", () => {
  const src = uiFiles.map((f) => fs.readFileSync(path.join(APP, f), "utf8"));
  const defined = new Set();
  for (const s of src) {
    for (const [, list] of s.matchAll(/Object\.assign\(Chef, \{([^}]*)\}\)/g)) list.split(",").map((x) => x.trim()).filter(Boolean).forEach((x) => defined.add(x));
  }
  const used = new Set();
  for (const s of src) for (const [, name] of s.matchAll(/Chef\.([A-Za-z_$][\w$]*)/g)) used.add(name);
  // Destructured helpers must be defined too.
  for (const s of src) for (const [, list] of s.matchAll(/const \{([^}]*)\} = Chef;/g)) list.split(",").map((x) => x.trim()).forEach((x) => used.add(x));
  const missing = [...used].filter((n) => !defined.has(n));
  assert.deepEqual(missing, [], `used but never defined: ${missing.join(", ")}`);
});
