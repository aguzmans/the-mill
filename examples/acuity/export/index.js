// @bun
// ../../tmp/claude-1001/-workspace-the-mill/05bd88a0-1a4f-45c5-975d-b2851a433814/scratchpad/workdir/acuity/workflows/create-invoice/nodes/invoice.js
async function createInvoice(input, ctx) {
  const p = input.customer ? input : input.payloads && input.payloads.invoice || input;
  const url = ctx.secrets.BILLING_API_URL;
  const key = ctx.secrets.BILLING_API_KEY;
  const invoice = { customer: p.customer, amountCents: p.amountCents, currency: p.currency || "usd", memo: p.memo };
  if (!url) {
    ctx.log.warn("BILLING_API_URL not set \u2014 simulating invoice (set it in Secrets to go live)");
    return { workload: "invoice", simulated: true, customer: p.customer, amountCents: p.amountCents };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...key ? { authorization: `Bearer ${key}` } : {} },
    body: JSON.stringify(invoice)
  });
  if (!res.ok) {
    ctx.log.error("billing error", { status: res.status });
    throw new Error(`billing ${res.status}`);
  }
  ctx.log.info("invoice created", { customer: p.customer, amountCents: p.amountCents });
  return { workload: "invoice", ok: true, status: res.status };
}

// ../../tmp/claude-1001/-workspace-the-mill/05bd88a0-1a4f-45c5-975d-b2851a433814/scratchpad/workdir/acuity/workflows/crm-upsert/nodes/crm.js
async function crmUpsert(input, ctx) {
  const p = input.patient ? input : input.payloads && input.payloads.crm || input;
  const url = ctx.secrets.CRM_API_URL;
  const key = ctx.secrets.CRM_API_KEY;
  if (!url) {
    ctx.log.warn("CRM_API_URL not set \u2014 simulating CRM upsert (set it in Secrets to go live)");
    return { workload: "crm", simulated: true, op: p.op, email: p.patient && p.patient.email };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...key ? { authorization: `Bearer ${key}` } : {} },
    body: JSON.stringify({ op: p.op, status: p.status, patient: p.patient })
  });
  if (!res.ok) {
    ctx.log.error("CRM error", { status: res.status });
    throw new Error(`CRM ${res.status}`);
  }
  ctx.log.info("CRM upsert", { op: p.op, email: p.patient && p.patient.email });
  return { workload: "crm", ok: true, status: res.status };
}

// ../../tmp/claude-1001/-workspace-the-mill/05bd88a0-1a4f-45c5-975d-b2851a433814/scratchpad/workdir/acuity/workflows/intake/nodes/verify.js
import crypto from "crypto";
function verify(input, ctx) {
  const req = ctx.request;
  if (!req)
    return input;
  const sig = req.headers["x-webhook-signature"] || req.headers["x-signature"];
  const secret = ctx.secrets.WEBHOOK_SECRET;
  if (secret && sig) {
    const expected = crypto.createHmac("sha256", secret).update(req.raw).digest("hex");
    if (sig !== expected)
      throw new Error("invalid webhook signature \u2014 rejected");
    ctx.log.info("signature verified");
  }
  let body = input;
  if ((!body || Object.keys(body).length === 0) && req.raw) {
    try {
      body = JSON.parse(req.raw);
    } catch {
      body = { raw: req.raw };
    }
  }
  ctx.log.info("webhook accepted", { contentType: req.contentType, bytes: req.raw.length });
  return body;
}

// ../../tmp/claude-1001/-workspace-the-mill/05bd88a0-1a4f-45c5-975d-b2851a433814/scratchpad/workdir/acuity/workflows/intake/nodes/fetch-acuity.js
async function fetchAcuity(input, ctx) {
  const id = input.id || input.appt && input.appt.id;
  const userId = ctx.secrets.ACUITY_USER_ID;
  const apiKey = ctx.secrets.ACUITY_API_KEY;
  if (!id) {
    ctx.log.warn("no appointment id on the webhook \u2014 nothing to fetch");
    return { ...input, appt: input.appt || {} };
  }
  if (!userId || !apiKey) {
    ctx.log.warn("ACUITY_USER_ID / ACUITY_API_KEY not set \u2014 skipping live fetch (add them in Secrets)");
    return { ...input, appt: input.appt || { id: String(id) }, acuity: { fetched: false, reason: "no credentials" } };
  }
  const auth = "Basic " + Buffer.from(`${userId}:${apiKey}`).toString("base64");
  const res = await fetch(`https://acuityscheduling.com/api/v1/appointments/${encodeURIComponent(id)}`, {
    headers: { authorization: auth, accept: "application/json" }
  });
  if (!res.ok) {
    ctx.log.error("Acuity API error", { id, status: res.status });
    throw new Error(`Acuity API ${res.status} fetching appointment ${id}`);
  }
  const a = await res.json();
  ctx.log.info("fetched appointment", { id: a.id, type: a.type, email: a.email });
  return {
    ...input,
    appt: {
      id: String(a.id),
      type: a.type,
      appointmentTypeID: a.appointmentTypeID,
      email: a.email,
      name: `${a.firstName || ""} ${a.lastName || ""}`.trim(),
      price: Number(a.price || 0),
      datetime: a.datetime,
      raw: a
    },
    acuity: { fetched: true }
  };
}

// ../../tmp/claude-1001/-workspace-the-mill/05bd88a0-1a4f-45c5-975d-b2851a433814/scratchpad/workdir/acuity/workflows/intake/nodes/fetch-internal.js
async function fetchInternal(input, ctx) {
  const email = input.appt && input.appt.email || input.email || "";
  let internal = { source: "ehr", known: false };
  try {
    const r = await fetch("https://postman-echo.com/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    internal = { source: "ehr", known: !!email, echoed: (await r.json()).data };
  } catch (e) {
    ctx.log.warn("ehr lookup failed", { error: String(e) });
  }
  return { ...input, internal };
}

// ../../tmp/claude-1001/-workspace-the-mill/05bd88a0-1a4f-45c5-975d-b2851a433814/scratchpad/workdir/acuity/workflows/intake/nodes/consolidate.js
function consolidate(input, ctx) {
  const action = input.action || "appointment.scheduled";
  const a = input.appt || input.appointment || { id: input.id, type: input.type, email: input.email, name: input.name, price: input.price };
  const typeMap = { "5": "new-patient", "6": "follow-up" };
  const appt = { id: a.id || "unknown", type: a.type || typeMap[input.appointmentTypeID] || "follow-up", email: a.email || "", name: a.name || "", price: Number(a.price || 0) };
  const scheduled = action === "appointment.scheduled";
  const newPatient = appt.type === "new-patient";
  const calls = [{ workflow: "crm-upsert", ref: "workflows/crm-upsert", input: { op: scheduled ? "upsert" : "update-status", patient: appt, status: scheduled ? "active" : "canceled" } }];
  if (scheduled)
    calls.push({ workflow: "send-confirmation", ref: "workflows/send-confirmation", input: { to: appt.email, channel: "email", template: newPatient ? "welcome" : "reminder", appt } });
  if (scheduled && newPatient)
    calls.push({ workflow: "create-invoice", ref: "workflows/create-invoice", input: { customer: appt.email, amountCents: Math.round(appt.price * 100), memo: `New patient visit ${appt.id}` } });
  ctx.log.info("routing", { appt: appt.id, targets: calls.map((c) => c.workflow) });
  return { appt, calls };
}

// ../../tmp/claude-1001/-workspace-the-mill/05bd88a0-1a4f-45c5-975d-b2851a433814/scratchpad/workdir/acuity/workflows/intake/nodes/summarize.js
function summarize(results, ctx) {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  ctx.log.info("dispatch complete", { called: results.map((r) => r.workflow), ok: ok.length, failed: failed.length });
  return { dispatched: results.length, ok: ok.length, failed: failed.length, workloads: results.map((r) => ({ workflow: r.workflow, ok: r.ok })) };
}

// ../../tmp/claude-1001/-workspace-the-mill/05bd88a0-1a4f-45c5-975d-b2851a433814/scratchpad/workdir/acuity/workflows/send-confirmation/nodes/send.js
async function sendConfirmation(input, ctx) {
  const p = input.to ? input : input.payloads && input.payloads.confirmation || input;
  const url = ctx.secrets.NOTIFY_API_URL;
  const key = ctx.secrets.NOTIFY_API_KEY;
  const message = {
    to: p.to,
    channel: p.channel || "email",
    template: p.template || "reminder",
    subject: p.template === "welcome" ? "Welcome to Novi Health" : "Your appointment is confirmed",
    appt: p.appt
  };
  if (!url) {
    ctx.log.warn("NOTIFY_API_URL not set \u2014 simulating confirmation (set it in Secrets to go live)");
    return { workload: "confirmation", simulated: true, to: p.to, template: message.template };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...key ? { authorization: `Bearer ${key}` } : {} },
    body: JSON.stringify(message)
  });
  if (!res.ok) {
    ctx.log.error("notify error", { status: res.status });
    throw new Error(`notify ${res.status}`);
  }
  ctx.log.info("confirmation sent", { to: p.to, template: message.template });
  return { workload: "confirmation", ok: true, status: res.status };
}

// packages/sdk/src/ctx.ts
function makeCtx(opts) {
  const secrets = {};
  for (const name of opts.declared ?? []) {
    if (name in opts.allSecrets)
      secrets[name] = opts.allSecrets[name];
  }
  const emit = (level) => (message, fields) => opts.onEvent?.({ type: "log", node: opts.node, level, message, fields });
  return {
    log: { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") },
    secrets,
    inputs: opts.inputs,
    state: opts.state,
    ...opts.request ? { request: opts.request } : {}
  };
}
// packages/sdk/src/runtime.ts
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class WorkflowError extends Error {
  node;
  cause;
  statuses;
  constructor(node, cause, statuses = {}) {
    super(`node '${node}' failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.node = node;
    this.cause = cause;
    this.statuses = statuses;
    this.name = "WorkflowError";
  }
}
function evalCondition(expr, input, ctx) {
  const fn = new Function("input", "ctx", `"use strict"; return (${expr});`);
  return Boolean(fn(input, ctx));
}
function checkSchema(expr, value, which, key) {
  let ok;
  try {
    ok = Boolean(new Function("input", "output", `"use strict"; return (${expr});`)(value, value));
  } catch (e) {
    throw new Error(`${which} schema of '${key}' errored: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!ok)
    throw new Error(`${which} schema violation on '${key}': ${expr}`);
}
function resolveEach(expr, input, ctx) {
  if (!expr)
    return input;
  const fn = new Function("input", "ctx", `"use strict"; return (${expr});`);
  return fn(input, ctx);
}
async function executePlan(plan, deps) {
  const outputs = {};
  const statuses = {};
  const activated = new Map;
  const activate = (from, to) => {
    const s = activated.get(to) ?? new Set;
    s.add(from);
    activated.set(to, s);
  };
  const state = {};
  let result = undefined;
  if (plan.inputSchema) {
    try {
      checkSchema(plan.inputSchema, deps.input, "input", plan.workflow);
    } catch (e) {
      throw new WorkflowError(plan.startKey, e, {});
    }
  }
  for (const key of plan.order) {
    const node = plan.nodes[key];
    if (!node)
      continue;
    const runnable = key === plan.startKey || (activated.get(key)?.size ?? 0) > 0;
    if (!runnable) {
      statuses[key] = "skipped";
      continue;
    }
    const liveParents = node.parents.filter((p) => activated.get(key)?.has(p));
    const inputsMap = {};
    for (const p of liveParents)
      inputsMap[p] = outputs[p];
    const primary = liveParents.length ? outputs[liveParents[0]] : deps.input;
    if (deps.journal && key in deps.journal && (node.kind === "jscode" || node.kind === "callScript" || node.kind === "loop")) {
      const out = deps.journal[key];
      outputs[key] = out;
      statuses[key] = "succeeded";
      for (const c of node.children)
        activate(key, c.to);
      deps.onEvent?.({ type: "log", node: key, level: "debug", message: "skipped \u2014 journaled from a prior attempt" });
      deps.onEvent?.({ type: "node", node: key, status: "succeeded", ms: 0 });
      continue;
    }
    const ctx = makeCtx({ node: key, inputs: inputsMap, allSecrets: deps.secrets ?? {}, declared: node.secrets, state, onEvent: deps.onEvent, request: deps.request });
    deps.onEvent?.({ type: "node", node: key, status: "running" });
    const t0 = performance.now();
    const attempts = Math.max(1, node.retry?.maxAttempts ?? 1);
    try {
      if (node.inputSchema)
        checkSchema(node.inputSchema, primary, "input", key);
      let out;
      for (let attempt = 1;; attempt++) {
        try {
          switch (node.kind) {
            case "start":
              out = deps.input;
              break;
            case "jscode": {
              const fn = await deps.loadNode(node);
              out = await fn(primary, ctx);
              break;
            }
            case "callScript":
              out = await deps.callScript(node.call, primary, ctx);
              break;
            case "loop": {
              const arr = resolveEach(node.each, primary, ctx);
              if (!Array.isArray(arr))
                throw new Error(`loop '${key}' expected an array to iterate (each: ${node.each ?? "input"}), got ${arr === null ? "null" : typeof arr}`);
              ctx.log.info(`loop over ${arr.length} item(s)`, { count: arr.length });
              const bodyFn = node.file ? await deps.loadNode(node) : null;
              const results = [];
              for (let i = 0;i < arr.length; i++) {
                ctx.state.index = i;
                ctx.state.item = arr[i];
                results.push(bodyFn ? await bodyFn(arr[i], ctx) : await deps.callScript(node.call, arr[i], ctx));
              }
              out = results;
              break;
            }
            case "fanout": {
              const targets = resolveEach(node.each, primary, ctx);
              if (!Array.isArray(targets))
                throw new Error(`fanout '${key}' expected an array of targets (each: ${node.each ?? "input"}), got ${targets === null ? "null" : typeof targets}`);
              ctx.log.info(`fanout \u2192 ${targets.length} target(s)`, { count: targets.length });
              out = await Promise.all(targets.map(async (t) => {
                const ref = t.ref ?? (t.workflow ? `workflows/${t.workflow}` : "");
                const label = t.workflow ?? ref;
                if (!ref)
                  return { workflow: label, ok: false, error: "target missing ref/workflow" };
                try {
                  return { workflow: label, ok: true, result: await deps.callScript({ workflow: t.workflow ?? ref, ref }, t.input ?? primary, ctx) };
                } catch (e) {
                  return { workflow: label, ok: false, error: e instanceof Error ? e.message : String(e) };
                }
              }));
              break;
            }
            case "if": {
              const taken = evalCondition(node.condition ?? "false", primary, ctx) ? "true" : "false";
              out = primary;
              for (const c of node.children)
                if (c.branch === taken)
                  activate(key, c.to);
              break;
            }
            case "end":
              out = primary;
              result = primary;
              break;
          }
          if (node.outputSchema)
            checkSchema(node.outputSchema, out, "output", key);
          break;
        } catch (e) {
          if (attempt >= attempts)
            throw e;
          const base = node.retry?.backoffMs ?? 0;
          const wait = node.retry?.jitter === false ? base * attempt : Math.round(base * attempt * (0.5 + Math.random()));
          deps.onEvent?.({ type: "log", node: key, level: "warn", message: `attempt ${attempt}/${attempts} failed: ${e instanceof Error ? e.message : String(e)} \u2014 retrying in ${wait}ms` });
          await sleep(wait);
        }
      }
      outputs[key] = out;
      statuses[key] = "succeeded";
      if (node.kind !== "if")
        for (const c of node.children)
          activate(key, c.to);
      deps.onNodeDone?.(key, out);
      deps.onEvent?.({ type: "node", node: key, status: "succeeded", ms: Math.round(performance.now() - t0) });
    } catch (err) {
      statuses[key] = "failed";
      deps.onEvent?.({ type: "node", node: key, status: "failed", ms: Math.round(performance.now() - t0), error: err instanceof Error ? err.message : String(err) });
      throw new WorkflowError(key, err, { ...statuses });
    }
  }
  return { result, outputs, statuses };
}
// ../../tmp/mill-export-1J28hx/entry.ts
var PLANS = { "create-invoice": { workflow: "create-invoice", startKey: "start", order: ["start", "invoice", "end"], nodes: { start: { key: "start", kind: "start", name: "Start", parents: [], children: [{ to: "invoice" }] }, invoice: { key: "invoice", kind: "jscode", name: "create-invoice", file: "nodes/invoice.js", secrets: ["BILLING_API_URL", "BILLING_API_KEY"], parents: ["start"], children: [{ to: "end" }] }, end: { key: "end", kind: "end", name: "End", parents: ["invoice"], children: [] } } }, "crm-upsert": { workflow: "crm-upsert", startKey: "start", order: ["start", "crm", "end"], nodes: { start: { key: "start", kind: "start", name: "Start", parents: [], children: [{ to: "crm" }] }, crm: { key: "crm", kind: "jscode", name: "crm-upsert", file: "nodes/crm.js", secrets: ["CRM_API_URL", "CRM_API_KEY"], parents: ["start"], children: [{ to: "end" }] }, end: { key: "end", kind: "end", name: "End", parents: ["crm"], children: [] } } }, intake: { workflow: "intake", startKey: "start", order: ["start", "verify", "fetch-acuity", "fetch-internal", "consolidate", "dispatch", "summarize", "end"], nodes: { start: { key: "start", kind: "start", name: "Start", parents: [], children: [{ to: "verify" }] }, verify: { key: "verify", kind: "jscode", name: "Verify + parse (any format)", file: "nodes/verify.js", secrets: ["WEBHOOK_SECRET"], parents: ["start"], children: [{ to: "fetch-acuity" }] }, "fetch-acuity": { key: "fetch-acuity", kind: "jscode", name: "Fetch appt (Acuity)", file: "nodes/fetch-acuity.js", secrets: ["ACUITY_USER_ID", "ACUITY_API_KEY"], parents: ["verify"], children: [{ to: "fetch-internal" }] }, "fetch-internal": { key: "fetch-internal", kind: "jscode", name: "Lookup patient (EHR)", file: "nodes/fetch-internal.js", parents: ["fetch-acuity"], children: [{ to: "consolidate" }] }, consolidate: { key: "consolidate", kind: "jscode", name: "Consolidate + route", file: "nodes/consolidate.js", parents: ["fetch-internal"], children: [{ to: "dispatch" }] }, dispatch: { key: "dispatch", kind: "fanout", name: "Call workloads (parallel)", each: "input.calls", parents: ["consolidate"], children: [{ to: "summarize" }] }, summarize: { key: "summarize", kind: "jscode", name: "Summarize", file: "nodes/summarize.js", parents: ["dispatch"], children: [{ to: "end" }] }, end: { key: "end", kind: "end", name: "End", parents: ["summarize"], children: [] } } }, "send-confirmation": { workflow: "send-confirmation", startKey: "start", order: ["start", "send", "end"], nodes: { start: { key: "start", kind: "start", name: "Start", parents: [], children: [{ to: "send" }] }, send: { key: "send", kind: "jscode", name: "send-confirmation", file: "nodes/send.js", secrets: ["NOTIFY_API_URL", "NOTIFY_API_KEY"], parents: ["start"], children: [{ to: "end" }] }, end: { key: "end", kind: "end", name: "End", parents: ["send"], children: [] } } } };
var TRIGGERS = { "create-invoice": ["manual"], "crm-upsert": ["manual"], intake: ["manual", "webhook"], "send-confirmation": ["manual"] };
var NODES = {
  "create-invoice/invoice": createInvoice,
  "crm-upsert/crm": crmUpsert,
  "intake/verify": verify,
  "intake/fetch-acuity": fetchAcuity,
  "intake/fetch-internal": fetchInternal,
  "intake/consolidate": consolidate,
  "intake/summarize": summarize,
  "send-confirmation/send": sendConfirmation
};
var WORKFLOWS = Object.keys(PLANS);
var resolveRef = (ref) => ref.startsWith("workflows/") ? ref.slice("workflows/".length) : ref;
async function runWorkflow(name, input) {
  const plan = PLANS[name];
  if (!plan)
    throw new Error("unknown workflow: " + name);
  const r = await executePlan(plan, {
    input,
    secrets: process.env,
    loadNode: async (node) => NODES[name + "/" + node.key],
    callScript: async (call, cin) => runWorkflow(resolveRef(call.ref), cin),
    onEvent: (e) => {
      if (process.env.MILL_VERBOSE)
        console.error(JSON.stringify(e));
    }
  });
  return r.result;
}
function serve(port) {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && (path === "/" || path === "/health")) {
        return Response.json({ ok: true, project: "acuity", workflows: WORKFLOWS.map((w) => ({ name: w, triggers: TRIGGERS[w] || [] })) });
      }
      const m = path.match(/^\/(?:run|hooks)\/(.+)$/);
      if (req.method === "POST" && m) {
        const name = decodeURIComponent(m[1]);
        if (!PLANS[name])
          return Response.json({ error: "unknown workflow: " + name }, { status: 404 });
        let input = {};
        try {
          const t = await req.text();
          input = t ? JSON.parse(t) : {};
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 });
        }
        try {
          return Response.json({ status: "succeeded", workflow: name, result: await runWorkflow(name, input) });
        } catch (e) {
          return Response.json({ status: "failed", workflow: name, error: String(e && e.message || e) }, { status: 500 });
        }
      }
      return Response.json({ error: "not found", routes: ["GET /health", "POST /run/:workflow", "POST /hooks/:workflow"] }, { status: 404 });
    }
  });
  console.error("mill bundle 'acuity' serving on http://localhost:" + server.port + " \u2014 POST /run/<workflow>");
  console.error("workflows: " + WORKFLOWS.join(", "));
}
var args = process.argv.slice(2);
if (args[0] === "serve") {
  serve(Number(args[1] || process.env.PORT || 8080));
} else {
  const [wf, inputJson] = args;
  runWorkflow(wf || "create-invoice", inputJson ? JSON.parse(inputJson) : {}).then((r) => console.log(JSON.stringify(r))).catch((e) => {
    console.error(String(e && e.message || e));
    process.exit(1);
  });
}
