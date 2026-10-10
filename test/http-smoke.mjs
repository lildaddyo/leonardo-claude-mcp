// HTTP smoke test: auth modes, id validation and per-request servers.
// Run with `npm test` (builds first). Uses a fake LEONARDO_API_KEY and never
// calls a paid Leonardo endpoint: every tools/call here is rejected locally.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const SERVER = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, extra = "") { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra); } }
async function start(port, env) {
  const p = spawn(process.execPath, [SERVER], { env: { ...process.env, LEONARDO_API_KEY: "test-not-a-real-key", TRANSPORT: "http", PORT: String(port), MCP_ACCESS_KEY: "", MCP_REQUIRE_AUTH: "", ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let log = ""; p.stderr.on("data", d => log += d);
  for (let i = 0; i < 300; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch {} await sleep(100); }
  return { p, log: () => log };
}
const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function rpc(port, path, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { ...H, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  let j = null; const t = await r.text(); try { j = JSON.parse(t); } catch {}
  return { status: r.status, j, t };
}
const list = id => ({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
const call = (name, args, id = 7) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

// open mode
{ const s = await start(3911, {}); const P = 3911;
  const h = await (await fetch(`http://127.0.0.1:${P}/health`)).json(); check("open: health auth=open", h.auth === "open");
  const r = await rpc(P, "/mcp", list(1)); check("open: tools/list 200 w/ 9 tools", r.status === 200 && r.j?.result?.tools?.length === 9, r.t.slice(0, 200));
  const r2 = await rpc(P, "/mcp/whatever", list(2)); check("open: /mcp/<x> accepted (transition)", r2.status === 200);
  const g = await fetch(`http://127.0.0.1:${P}/mcp`); check("open: GET /mcp -> 405", g.status === 405);
  check("open: loud warning logged", /UNAUTHENTICATED/.test(s.log()));
  // leo-3 traversal
  const t = await rpc(P, "/mcp", call("leonardo_get_generation", { generation_id: "../models/abc" }));
  const txt = JSON.stringify(t.j);
  check("leo-3: traversal id rejected by schema", /UUID/.test(txt) && !/Leonardo API/.test(txt), txt.slice(0, 300));
  const t2 = await rpc(P, "/mcp", call("leonardo_delete_generation", { generation_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6/../../models/x" }));
  check("leo-3: delete traversal rejected", /UUID/.test(JSON.stringify(t2.j)) && !/Leonardo API/.test(JSON.stringify(t2.j)));
  const t3 = await rpc(P, "/mcp", call("leonardo_generate_image", { prompt: "x", model_id: "../x" }));
  check("leo-3: bad model_id rejected", /model_id/.test(JSON.stringify(t3.j)) && !/Leonardo API/.test(JSON.stringify(t3.j)));
  // leo-4 concurrency
  const many = await Promise.all(Array.from({ length: 25 }, (_, i) => rpc(P, "/mcp", list(1000 + i))));
  check("leo-4: 25 parallel requests each get own id", many.every((m, i) => m.status === 200 && m.j?.id === 1000 + i && m.j?.result?.tools?.length === 9), JSON.stringify(many.map(m => [m.status, m.j?.id])));
  s.p.kill(); }

// enforced mode
{ const s = await start(3912, { MCP_ACCESS_KEY: "  keyAlpha-0123456789abcdef0123456789 , keyBeta-0123456789abcdef0123456789  " }); const P = 3912;
  const A = "keyAlpha-0123456789abcdef0123456789", B = "keyBeta-0123456789abcdef0123456789";
  const h = await (await fetch(`http://127.0.0.1:${P}/health`)).json(); check("enf: health auth=enforced", h.auth === "enforced");
  check("enf: no auth -> 401", (await rpc(P, "/mcp", list(1))).status === 401);
  check("enf: wrong path -> 401", (await rpc(P, "/mcp/nope", list(1))).status === 401);
  check("enf: prefix of key -> 401", (await rpc(P, "/mcp/" + A.slice(0, -1), list(1))).status === 401);
  check("enf: key A path -> 200", (await rpc(P, "/mcp/" + A, list(1))).status === 200);
  check("enf: key B path -> 200 (rotation)", (await rpc(P, "/mcp/" + B, list(1))).status === 200);
  check("enf: Bearer A -> 200", (await rpc(P, "/mcp", list(1), { authorization: "Bearer " + A })).status === 200);
  check("enf: lowercase bearer -> 200", (await rpc(P, "/mcp", list(1), { authorization: "bearer " + A })).status === 200);
  check("enf: Bearer wrong -> 401", (await rpc(P, "/mcp", list(1), { authorization: "Bearer nope" })).status === 401);
  check("enf: Bearer empty -> 401", (await rpc(P, "/mcp", list(1), { authorization: "Bearer " })).status === 401);
  check("enf: Basic A -> 401", (await rpc(P, "/mcp", list(1), { authorization: "Basic " + A })).status === 401);
  check("enf: comma-joined keys -> 401", (await rpc(P, "/mcp/" + encodeURIComponent(A + "," + B), list(1))).status === 401);
  check("enf: wrong path + good Bearer -> 200", (await rpc(P, "/mcp/nope", list(1), { authorization: "Bearer " + A })).status === 200);
  check("enf: case-changed key -> 401", (await rpc(P, "/mcp/" + A.toUpperCase(), list(1))).status === 401);
  const big = await rpc(P, "/mcp", "x".repeat(500_000)); check("enf: big unauth body -> 401 (not parsed)", big.status === 401);
  const bad = await rpc(P, "/mcp/" + A, "{not json"); check("enf: malformed JSON -> 400 JSON, no key echo", bad.status === 400 && !bad.t.includes(A), bad.t.slice(0, 200));
  const big2 = await rpc(P, "/mcp/" + A, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(200_000) } })); check("enf: >100kb auth body -> 413", big2.status === 413);
  check("enf: key never logged", !s.log().includes(A) && !s.log().includes(B));
  check("enf: GET /mcp/<key> -> 405", (await fetch(`http://127.0.0.1:${P}/mcp/${A}`)).status === 405);
  s.p.kill(); }

// short key warning
{ const s = await start(3913, { MCP_ACCESS_KEY: "short" }); await sleep(200); check("short key warns", /shorter than 32/.test(s.log())); check("short key enforced", (await rpc(3913, "/mcp", list(1))).status === 401); s.p.kill(); }
// whitespace-only key -> open + warning
{ const s = await start(3914, { MCP_ACCESS_KEY: "   ,  " }); const h = await (await fetch("http://127.0.0.1:3914/health")).json(); check("blank key -> open mode", h.auth === "open"); s.p.kill(); }
// locked
{ const s = await start(3915, { MCP_REQUIRE_AUTH: "TRUE" }); check("locked: 503", (await rpc(3915, "/mcp", list(1))).status === 503); check("locked: path also 503", (await rpc(3915, "/mcp/x", list(1))).status === 503); s.p.kill(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
