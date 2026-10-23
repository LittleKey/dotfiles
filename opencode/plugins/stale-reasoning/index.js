// stale-reasoning: OpenCode v2.1.x fork.
// Upstream design (v2.0.24) relied on session http.request/http.response hooks; in v2.1.2 the
// session-drain replay path bypasses them (verified empirically 2026-10-23), so interception
// moved to: retry hook (does fire on drain failures) to mark poisoned reasoning item ids +
// force one retry, and the "context" model-request hook (mutable messages) to strip the
// encrypted payload of marked items from outgoing requests. A globalThis.fetch wrapper is kept
// as belt-and-suspenders for paths where it does apply.
const CODES = new Set(["invalid_encrypted_content", "thinking_signature_invalid"]);
// v2.1.2 drain errors arrive as "invalid_encrypted_content: The encrypted content for item ..." (prefixed), so no ^ anchor.
const VERIFY = /The encrypted content for item (\S+) could not be verified/;

const foreign = new Set(); // reasoning item ids an upstream refused to decrypt (rs_* are globally unique)
const poisoned = new Set(); // sessionIDs whose stored encrypted reasoning is undecryptable; strip all of it
const retried = new Map(); // sessionID -> Set of error markers already force-retried

import { appendFileSync } from "node:fs";
const DBG = "/tmp/opencode/stale-debug.log";
const dbg = (m) => { try { appendFileSync(DBG, `${new Date().toISOString()} ${m}\n`); } catch {} };

// Walk a message part; find reasoning item ids carrying encrypted content.
// v2.1.2 hook shape: encrypted reasoning piggybacks on part.providerMetadata.<provider> = { itemId, reasoningEncryptedContent, ... }.
const collectEnc = (part, found) => {
  if (!part || typeof part !== "object") return;
  const pm = part.providerMetadata;
  if (pm && typeof pm === "object") {
    for (const prov of Object.values(pm)) {
      if (prov && typeof prov === "object" && typeof prov.reasoningEncryptedContent === "string" && prov.reasoningEncryptedContent) {
        found.push({ holder: prov, id: prov.itemId });
      }
    }
  }
  const nat = part.native ?? part.metadata?.native;
  if (nat && typeof nat === "object" && typeof nat.reasoningEncryptedContent === "string" && nat.reasoningEncryptedContent) {
    found.push({ holder: nat, id: nat.itemId });
  }
};

const stripMarked = (messages, sessionID) => {
  let stripped = 0;
  let encTotal = 0;
  const all = poisoned.has(sessionID);
  for (const msg of messages ?? []) {
    const parts = msg?.parts ?? msg?.content;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const found = [];
      collectEnc(part, found);
      for (const { holder, id } of found) {
        encTotal++;
        if (all || (id && foreign.has(id))) {
          for (const k of Object.keys(holder)) delete holder[k]; // drop the whole native payload (itemId included): the part lowers to plain text
          stripped++;
        }
      }
    }
  }
  return { stripped, encTotal };
};

const providerPOST = (url) =>
  typeof url === "string" && /\/(responses|chat\/completions|completions)(\?|$)/.test(url);

const reasoningIds = (input) =>
  (Array.isArray(input) ? input : [])
    .filter((i) => i?.type === "reasoning" && i.encrypted_content && i.id)
    .map((i) => i.id);

const stripInput = (input) => {
  let dropped = 0;
  const out = (Array.isArray(input) ? input : []).flatMap((item) => {
    if (item?.type !== "reasoning" || !item.encrypted_content || !foreign.has(item.id)) return [item];
    dropped++;
    const summary = Array.isArray(item.summary) ? item.summary.filter((s) => s?.text) : [];
    return summary.length ? [{ type: "reasoning", summary }] : [];
  });
  return { out, dropped };
};

const rebuild = (request, text) => {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request, { headers, body: text });
};

async function handle(request, origFetch) {
  const url = request.url;
  if (request.method !== "POST" || !providerPOST(url)) return origFetch(request);
  let body;
  try {
    body = JSON.parse(await request.clone().text());
  } catch {
    return origFetch(request);
  }
  if (!body || !Array.isArray(body.input)) return origFetch(request);
  for (let attempt = 0; attempt < 2; attempt++) {
    const ids = reasoningIds(body.input);
    const { out, dropped } = stripInput(body.input);
    const req = dropped ? rebuild(request, JSON.stringify({ ...body, input: out })) : request;
    if (dropped) dbg(`fetch strip url=${url.slice(-24)} encIds=${ids.length} dropped=${dropped}`);
    const response = await origFetch(req);
    if (response.status !== 400) return response;
    const errText = await response.clone().text();
    let error;
    try { error = JSON.parse(errText)?.error; } catch { return response; }
    const named = VERIFY.exec(error?.message ?? "")?.[1]?.replace(/[.,;:]+$/, "");
    if (!CODES.has(error?.code) && !named) return response;
    const marked = named && ids.includes(named) ? ids : named ? [] : ids;
    if (!marked.length) return response;
    for (const id of marked) foreign.add(id);
    dbg(`fetch marked url=${url.slice(-24)} ids=${marked.length}`);
  }
  return origFetch(request);
}

export default {
  id: "stale-reasoning",
  async setup(ctx) {
    // Path A: retry hook fires even for drain failures (verified v2.1.2).
    await ctx.session.hook("retry", (event) => {
      const msg = event.error?.message ?? "";
      const named = VERIFY.exec(msg)?.[1]?.replace(/[.,;:]+$/, "");
      if (!named && !CODES.has(event.error?.code)) return;
      if (event.error?.status !== undefined && event.error.status !== 400) return;
      if (named) foreign.add(named);
      poisoned.add(event.sessionID); // after a rejection, all of this session's stored encrypted reasoning is suspect
      const key = named ?? msg.slice(0, 64);
      let seen = retried.get(event.sessionID);
      if (!seen) retried.set(event.sessionID, (seen = new Set()));
      if (event.attempt <= 2 && !seen.has(key)) {
        seen.add(key);
        event.decision = { retry: true, delay: 0 };
        dbg(`retry FORCE sid=${event.sessionID} item=${named?.slice(0, 18) ?? "?"} attempt=${event.attempt} foreignTotal=${foreign.size} poisonedTotal=${poisoned.size}`);
      }
    });

    // Path B: strip marked items from outgoing model requests (drain path included, if fired).
    for (const kind of ["context", "generate", "title", "compaction"]) {
      await ctx.session.hook(kind, (event) => {
        const r = stripMarked(event.messages, event.sessionID);
        const nMsgs = Array.isArray(event.messages) ? event.messages.length : -1;
        const partKeys = event.messages?.[0]?.parts?.[0] ? Object.keys(event.messages[0].parts[0]).join("+") : event.messages?.[0]?.content?.[0] ? `c:${Object.keys(event.messages[0].content[0]).join("+")}` : "?";
        if (r.encTotal > 0 || r.stripped > 0)
          dbg(`${kind} sid=${event.sessionID ?? "?"} msgs=${nMsgs} encParts=${r.encTotal} stripped=${r.stripped} partKeys=${partKeys}`);
      });
    }

    // Path C: fetch wrapper for any provider traffic visible in this realm.
    const orig = globalThis.fetch;
    if (orig && !orig.__staleWrapped) {
      const wrapped = (input, init) => {
        try {
          const request = input instanceof Request ? input : new Request(input, init);
          return handle(request, orig);
        } catch {
          return orig(input, init);
        }
      };
      wrapped.__staleWrapped = true;
      globalThis.fetch = wrapped;
      dbg("fetch wrapper installed");
    }
  },
};
