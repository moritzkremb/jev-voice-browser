/**
 * Controller flow with a mocked Jev and a fake browser: debounce, one action per utterance,
 * stale-request handling, candidate picking by number, chaining commands in one breath.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../../src/controller.js";
import { DEBOUNCE_MS, CONFIRMATION_TTL_MS } from "../../src/constants.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeBrowser() {
  return {
    url: "https://example.com/",
    onChange() {
      return () => {};
    },
    tabInfo() {
      return [{ index: 0, url: this.url, active: true }];
    },
    async snapshot() {
      return {
        url: this.url,
        title: "Example",
        site: "example_com",
        searchBoxId: null,
        elements: [
          { id: "e01", role: "link", text: "More information" },
          { id: "e02", role: "link", text: "Other link" },
          { id: "e03", role: "button", text: "Place order" },
        ],
        tabs: this.tabInfo(),
      };
    },
    overlayCalls: [],
    async overlay(fn, ...args) {
      this.overlayCalls.push([fn, ...args]);
    },
  };
}

/** Mock Jev: keyword-driven answers, with configurable latency. */
function mockDecide({ latency = 20, complete = (t) => (t.split(" ").length >= 2 ? 0.9 : 0.1) } = {}) {
  const calls = [];
  const fn = async ({ transcript }, { signal } = {}) => {
    calls.push(transcript);
    if (latency > 0) await sleep(latency);
    if (signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    const t = transcript.toLowerCase();
    const ch = (c, conf = 0.95, extra = {}) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf, ...extra } });
    let intent = ch("none", 0.9);
    let target = ch("none", 0.9);
    if (t === "confirm" || t === "cancel") intent = ch(t);
    else if (t.startsWith("go back")) intent = ch("go_back");
    else if (t.startsWith("scroll")) intent = ch("scroll_down");
    else if (t.startsWith("click ambiguous")) {
      intent = ch("click_element");
      target = ch("e01", 0.2, { e02: 0.4, none: 0.2 });
    } else if (t.startsWith("click")) {
      intent = ch("click_element");
      target = ch(t === "click place order" ? "e03" : "e01", 0.95);
    }
    return {
      answers: {
        intent,
        target,
        site: ch("none"),
        complete: { noul: complete(t) },
        is_command: { noul: intent.choice === "none" ? 0.1 : 0.95 },
        destructive: { noul: t === "click place order" ? 0.95 : 0.02 },
        scroll_amount: { score: 1, confidence: 0.9, probabilities: {} },
        tab_direction: ch("none"),
      },
      latencyMs: latency,
      usage: { input_tokens: 1000, output_tokens: 10 },
      costUsd: 0.000042,
      model: "jev-1.13.0",
      requestId: "req",
      candidates: { text: [], url: [] },
      state: {},
      questionCount: 8,
    };
  };
  fn.calls = calls;
  return fn;
}

function setup(opts = {}) {
  const browser = fakeBrowser();
  const executed = [];
  const decideFn = mockDecide(opts);
  const executeFn = async (action) => {
    executed.push(action);
    if ((opts.execMs ?? 10) > 0) await sleep(opts.execMs ?? 10);
    return { ok: true, detail: "ok" };
  };
  const c = new Controller({ browser, decideFn, executeFn });
  return { c, browser, executed, decideFn };
}

test("debounces partials into one request and acts once per utterance", async () => {
  const { c, executed, decideFn } = setup();
  await c.start();
  c.handleTranscript({ text: "go", final: false, utteranceId: "u1" });
  await sleep(50);
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u1" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, "go_back");
  assert.equal(decideFn.calls.length, 1, "first partial was debounced away");
  // the rest of the same utterance is ignored
  c.handleTranscript({ text: "go back please", final: true, utteranceId: "u1" });
  await sleep(DEBOUNCE_MS + 100);
  assert.equal(executed.length, 1);
  assert.equal(c.uiState().stats.calls, 1);
  assert.ok(c.uiState().stats.costUsd > 0);
  await c.close();
});

test("waits on an incomplete partial, then acts when the recognizer marks it final", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleTranscript({ text: "scroll", final: false, utteranceId: "u2" });
  await sleep(DEBOUNCE_MS + 100);
  assert.equal(executed.length, 0);
  assert.equal(c.lastDecision.policy.decision, "wait");
  c.handleTranscript({ text: "scroll", final: true, utteranceId: "u2" });
  await sleep(150);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, "scroll_down");
  await c.close();
});

test("cancels stale in-flight requests beyond MAX_INFLIGHT", async () => {
  const { c, executed, decideFn } = setup({ latency: 400 });
  await c.start();
  c.handleTranscript({ text: "go", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  c.handleTranscript({ text: "go ba", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  assert.equal(c.inflight.length, 2, "oldest request aborted, two in flight");
  await sleep(600);
  assert.equal(executed.length, 1);
  assert.equal(decideFn.calls.length, 3);
  await c.close();
});

test("ambiguous target shows numbered candidates; a spoken number picks without a model call", async () => {
  const { c, executed, browser, decideFn } = setup();
  await c.start();
  c.handleTranscript({ text: "click ambiguous thing", final: true, utteranceId: "u4" });
  await sleep(150);
  assert.equal(executed.length, 0);
  assert.ok(c.candidates, "candidates pending");
  assert.deepEqual(
    c.candidates.list.map((x) => x.id),
    ["e02", "e01"],
  );
  assert.ok(browser.overlayCalls.some(([fn]) => fn === "candidates"));
  const callsBefore = decideFn.calls.length;
  c.handleTranscript({ text: "the second one", final: true, utteranceId: "u5" });
  await sleep(100);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].targetId, "e01");
  assert.equal(decideFn.calls.length, callsBefore, "no Jev call for the number");
  await c.close();
});

test("commands spoken in one breath: words after an executed command become a new command", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 1);
  c.handleTranscript({ text: "go back scroll down", final: false, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 2);
  assert.equal(executed[1].type, "scroll_down");
  // one trailing word is ignored
  c.handleTranscript({ text: "go back scroll down please", final: true, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 2);
  await c.close();
});

test("typed command is treated as a final utterance", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleCommand("go back");
  await sleep(150);
  assert.equal(executed.length, 1);
  await c.close();
});

/** Drive confirmation decisions directly, with no real debounce, API or execution delays. */
async function setupConfirmation(t) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const state = setup({ latency: 0, execMs: 0 });
  const { c } = state;
  t.after(() => c.close());
  const pendingEvents = [];
  c.on("pending", (p) => pendingEvents.push(p));
  let id = 0;
  const command = async (text) => {
    c.handleTranscript({ text, final: true, utteranceId: `confirmation-${++id}` });
    clearTimeout(c.debounceTimer);
    await c.decideNow();
  };
  await c.start();
  await command("click place order");
  assert.equal(c.lastDecision.policy.decision, "confirm");
  assert.equal(state.executed.length, 0);
  return { ...state, command, pendingEvents };
}

test("pending confirmation can be confirmed just before expiry, once only", async (t) => {
  const { c, command, executed, pendingEvents, browser } = await setupConfirmation(t);
  t.mock.timers.tick(CONFIRMATION_TTL_MS - 1);
  await command("confirm");
  await command("confirm");
  assert.equal(executed.length, 1);
  assert.equal(executed[0].targetId, "e03");
  assert.equal(executed[0].confirmed, true);
  assert.equal(c.pending, null);
  assert.equal(pendingEvents.at(-1), null);
  assert.ok(browser.overlayCalls.some(([fn, , ms]) => fn === "toast" && ms === CONFIRMATION_TTL_MS));
});

test("pending confirmation expires at the deadline without another command", async (t) => {
  const { c, command, executed, pendingEvents } = await setupConfirmation(t);
  t.mock.timers.tick(CONFIRMATION_TTL_MS - 1);
  assert.ok(c.pending);
  t.mock.timers.tick(1);
  assert.equal(c.pending, null);
  assert.equal(c.uiState().pending, null);
  assert.equal(pendingEvents.at(-1), null);
  await command("confirm");
  assert.deepEqual(executed, []);
});

test("pending confirmation is checked before a request even if the expiry timer is delayed", async (t) => {
  const { c, command, executed, pendingEvents } = await setupConfirmation(t);
  const decide = c._decide;
  let sentPending;
  c._decide = (state, opts) => {
    sentPending = state.pendingConfirmation;
    return decide(state, opts);
  };
  // Advance the clock without running timers, as when the event loop has been blocked.
  t.mock.timers.setTime(Date.now() + CONFIRMATION_TTL_MS);
  await command("confirm");
  assert.deepEqual(executed, []);
  assert.equal(sentPending, null);
  assert.equal(pendingEvents.at(-1), null);
});

test("pending confirmation expiring during a request cannot execute", async (t) => {
  const { c, command, executed } = await setupConfirmation(t);
  t.mock.timers.tick(CONFIRMATION_TTL_MS - 1);
  const decide = c._decide;
  c._decide = (state, opts) => {
    assert.ok(state.pendingConfirmation, "still valid when the request starts");
    t.mock.timers.setTime(Date.now() + 1);
    return decide(state, opts);
  };
  await command("confirm");
  assert.deepEqual(executed, []);
  assert.equal(c.pending, null);
});

for (const via of ["command", "candidate-pick", "undo"]) {
  test(`pending confirmation is cleared by an unrelated action via ${via}`, async (t) => {
    const { c, command, executed, pendingEvents, decideFn } = await setupConfirmation(t);
    if (via === "command") await command("scroll down");
    else if (via === "undo") await c.undo();
    else {
      await command("click ambiguous link");
      const callsBefore = decideFn.calls.length;
      await command("two");
      assert.equal(decideFn.calls.length, callsBefore, "candidate pick bypasses Jev");
    }
    await command("confirm");
    assert.equal(executed.length, 1);
    assert.notEqual(executed[0].targetId, "e03", "the destructive click was not executed");
    assert.equal(c.pending, null);
    assert.equal(pendingEvents.at(-1), null);
  });
}

test("pending confirmation is cleared by cancel", async (t) => {
  const { c, command, executed, pendingEvents } = await setupConfirmation(t);
  await command("cancel");
  await command("confirm");
  assert.deepEqual(executed, []);
  assert.equal(c.pending, null);
  assert.equal(pendingEvents.at(-1), null);
});

test("pending confirmation survives ignored speech without extending its deadline", async (t) => {
  const { c, command, executed } = await setupConfirmation(t);
  t.mock.timers.tick(CONFIRMATION_TTL_MS - 1);
  await command("let's get lunch");
  assert.equal(c.lastDecision.policy.decision, "ignore");
  assert.ok(c.pending);
  t.mock.timers.tick(1);
  await command("confirm");
  assert.deepEqual(executed, []);
});

test("pending confirmation replacement gets a fresh deadline", async (t) => {
  const { c, command } = await setupConfirmation(t);
  t.mock.timers.tick(CONFIRMATION_TTL_MS / 2);
  await command("click place order");
  t.mock.timers.tick(CONFIRMATION_TTL_MS / 2);
  assert.ok(c.pending, "the old timer must not clear the new confirmation");
  t.mock.timers.tick(CONFIRMATION_TTL_MS / 2);
  assert.equal(c.pending, null);
});

test("pending confirmation timer is cleaned up on close", async (t) => {
  const { c, pendingEvents } = await setupConfirmation(t);
  await c.close();
  const notifications = pendingEvents.length;
  const clearPending = t.mock.method(c, "_clearPending");
  t.mock.timers.tick(CONFIRMATION_TTL_MS);
  assert.equal(clearPending.mock.callCount(), 0, "no expiry callback after close");
  assert.equal(pendingEvents.length, notifications, "no expiry event after close");
});
