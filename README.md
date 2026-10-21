# voice-browser — talk to a real browser, it acts before you finish the sentence

A Node app that controls a **headed Chromium window** (Playwright) by voice. Speech is streamed
word by word from the browser's Web Speech API to a small Node server; on every partial transcript
the server asks **Jev** (TypeSafe's System One model, `jev-1.13.0`) one request with a dozen typed
questions — intent, target element, site, "is the command complete?", "is this even addressed to
me?", "is it destructive?" — gets typed probabilities back in ~250–350 ms, and code decides whether
to act, wait, ask, or ignore.

Jev never generates text. Search queries, typed text and URLs are extracted as candidate spans by
code and Jev only *picks* one, which is copied verbatim.

```
 mic (Chrome, Web Speech API)          Node server (owns the API key)             controlled window
 ───────────────────────────    ws     ───────────────────────────────────         ──────────────────
 partial transcripts  ───────────────▶ debounce 200 ms                            headed Chromium via
 "go to"  "go to wiki"                 snapshot page (≤100 elements, e01..eNN) ◀── Playwright, persistent
 "go to wikipedia" (final)             ONE Jev request: 9–11 questions             profile, overlay
                                       policy (thresholds in constants.js)  ───▶  highlight / toast /
 control page ◀─────────────────────── decision + bars + latency + cost            numbered candidates
```

## Run it

Requirements: Node ≥ 20 (tested on 22), npm, Chrome or Edge for the microphone (the Web Speech API
is not available in Firefox/Safari). Real API calls cost ~$0.0002 each.

```bash
git clone https://github.com/moritzkremb/jev-voice-browser.git
cd jev-voice-browser
npm install
npx playwright install chromium
cp .env.example .env          # paste your TypeSafe API key (https://console.typesafe.ai/keys)
./run.sh                      # starts the server on http://localhost:8787
```

Then open **http://localhost:8787 in your normal Chrome**, click **Start mic**, allow the
microphone, and speak. A separate Chromium window (the *controlled* browser) is opened by the server;
that is the one that acts. Keep the control page visible on a second screen / half the screen for
the live probability bars.

Options: `./run.sh --port 9000`, `--host 0.0.0.0` (LAN, see Security), `--start-url https://…`, `--headless` (CI), or attach to a Chrome
you already have running instead of launching one:

```bash
# start your Chrome with a debugging port, then:
./run.sh --cdp http://127.0.0.1:9222
```

Set the key yourself instead of `.env`: `export TYPESAFE_API_KEY=…` (legacy `JEV_API_KEY` is
also accepted) and `npm start`. The key is only ever read by the Node process; the control page
never sees it.

**Security:** the server listens on `127.0.0.1` only. Anyone who can reach the control port can
drive the browser and spend your API credits, so only use `--host 0.0.0.0` on a network you trust.
The controlled Chromium uses a persistent profile in `.browser-profile/` (gitignored) — don't log
into accounts there that you wouldn't want a mis-heard "click place order" to touch; destructive
clicks require a spoken "confirm", but treat that as a convenience, not a guarantee.

No microphone? Type a command into the text box on the control page and press Enter.

## What you can say

| Say | What happens |
| --- | --- |
| "go to wikipedia" / "open youtube" / "go to example dot com" | navigates (site list or spoken domain, code owns the URLs) |
| "search for alan turing" | uses the page's own search box if it has one (Wikipedia, YouTube…), else DuckDuckGo |
| "search youtube for lofi beats" | site-specific search URL template |
| "click the first result" / "click the new link" / "open the comments tab" | clicks the element Jev picked from the snapshot; ambiguous → numbered overlays, say "two" |
| "type hello world into the search box" | types verbatim (Jev picked the span, code copies it) |
| "scroll down a bit" / "scroll to the bottom" / "scroll up a page" | scroll with amount from a 3-level Score |
| "go back" / "go forward" / "reload" | history |
| "open a new tab" / "close this tab" / "next tab" | tabs |
| "click place order" | destructive → toast asks you to say **"confirm"** (or "cancel") |
| "so anyway I think we should get lunch" | ignored (`is_command` ≈ 0.02) |

Two commands in one breath work too: "go to example dot com and click the more information link".

## How a decision is made

Every transcript update produces exactly one Jev request (`src/jev.js`). State:

```json
{ "transcript": "open the documentation",
  "page": { "url": "https://typesafe.ai/jev", "title": "Jev", "site": "generic" },
  "elements": ["e03 link \"Documentation\" → docs.typesafe.ai", "e07 link \"Read the docs\" → docs.typesafe.ai", "..."],
  "context": {
    "previous_page": { "url": "https://duckduckgo.com/?q=jev+typesafe", "title": "jev typesafe at DuckDuckGo" },
    "recent_actions": [
      { "said": "click the first result", "action": "click_element", "target": "link \"TypeSafe — Jev\"", "outcome": "navigated to typesafe.ai/jev", "seconds_ago": 6 },
      { "said": "search for jev typesafe", "action": "navigate_url", "outcome": "navigated to duckduckgo.com/?q=jev+typesafe", "seconds_ago": 25 } ] } }
```

`context` is the conversation so far: the page you came from and the last three executed actions
(what you said, what was done, what happened). It is what makes "go back to the results", "no, not
that one", "the other one" and "open its documentation" resolvable — Jev has no memory between
requests, so the memory lives in the state.

Questions (all in `src/constants.js`, asked together, answered in parallel):

| id | type | answers |
| --- | --- | --- |
| `intent` | Choice | navigate_url · search_web · click_element · type_into_field · select_option · press_enter · scroll_down/up · go_back/forward · reload · open/close/switch tab · confirm · cancel · none — each option has `{what, not_for, examples}` |
| `target` | Choice | the element ids on the page + `none` |
| `site` | Choice | google · duckduckgo · the_web · youtube · wikipedia · github · amazon · reddit · twitter_x · hacker_news · example_com · other_named_site · none |
| `complete` | Noul | has the user finished the command? (lets us act on partial speech) |
| `is_command` | Noul | is the user addressing the browser at all? |
| `destructive` | Noul | would it submit / buy / delete / send? |
| `scroll_amount` | Score | a little · one page · to the end |
| `text_span` | Choice | verbatim candidate spans extracted by regex (+ `none`) — only when the transcript has any |
| `url_span` | Choice | domain-looking spans (+ `none`) — only when present |
| `tab_direction` | Choice | next · previous · first · none |
| `is_correction` | Noul | is the user rejecting / redirecting the most recent action in `context.recent_actions`? — only asked when there is history |

Policy (`src/policy.js`, thresholds `T` in `constants.js`), shown live in the UI as a gate table:

0. `is_correction ≥ 0.6` on a finished phrase: with no confident new command ("no, not that one",
   "undo that") → reverse the last action (click/navigate → back, typing → clear, scroll → opposite);
   with a new target ("no, the other one") → the previously clicked element is excluded from the
   candidates. A confident closed-set command ("go back" after a scroll) is never treated as a correction.
1. `is_command ≥ 0.5` else **ignore**
2. `intent.confidence ≥ 0.55` and not `none` else **wait**
3. `complete ≥ 0.6`, or 900 ms of silence, or the recognizer's final result — else **wait**
4. free-text intents (search / type) additionally wait for the final result or 600 ms silence, so a
   query is never truncated ("search for alan" vs "search for alan turing")
5. build the action in code: URL templates, search-box fallback, verbatim span copy
6. click/type targets need `target.confidence ≥ 0.45` and top probability ≥ 0.35, else the top 2–3
   candidates get numbered overlays in the page and a spoken number picks one (no model call)
7. `destructive ≥ 0.5` on a click → **confirm** (say "confirm" / "cancel"); the pending action
   expires after 10 seconds and is cleared when any other action is executed

Requests overlap: up to 2 in flight; older ones are cancelled with `AbortSignal`. A response for a
partial transcript may still act if the words already commit to a closed-set action ("go back"),
but is never treated as final for free text.

## Project layout

```
src/constants.js   MODEL pin, thresholds, every question text — the one file to review on camera
src/jev.js         builds state + questions, calls @typesafe-ai/sdk, returns answers/latency/usage/cost
src/spans.js       candidate extraction (text payloads, spoken URLs, number words) — code, not Jev
src/snapshot.js    in-page element collector (tags data-vb-id), compaction + size guard, site detection
src/policy.js      answers → act / wait / ignore / confirm / disambiguate, with reasons
src/executor.js    Playwright actions + overlay feedback
src/browser.js     launch headed Chromium (persistent profile) or attach via CDP; tabs
src/overlay.js     injected highlight / toast / numbered badges
src/controller.js  debounce, in-flight management, one action per utterance, chaining, stats
src/server.js      Express + ws, serves src/public/index.html (control page)
scripts/demo.js    word-by-word replay against real sites = end-to-end test
test/unit/         spans, snapshot compaction, policy (mocked Jev), controller (mocked Jev + browser), context encoding + corrections
test/integration/  34 real-API cases on captured page fixtures (incl. context / correction), prints pass rate + latency
```

## Tests and demo

```bash
npm test                 # unit tests (no network)
npm run test:integration # real Jev calls on fixtures; prints pass rate (expects ≥ 90%)
npm run demo             # headed replay of 16 spoken commands against real sites, asserts URLs
npm run demo:ci          # same, headless; exit code 1 on failure
node scripts/demo.js --headless --only 1,2,3 --word-ms 250
```

Latest measured (Sep 2026, from this machine): integration 34/34 (100%, incl. 7 context/correction cases), Jev latency avg ≈ 330 ms
(p50 ≈ 300 ms, 3–6k input tokens per request; the first request of a process is ~700 ms for the
TLS handshake), last-word→decision ≈ 300 ms including the 200 ms debounce, whole demo ≈ $0.01.

## Notes and limitations

- Web Speech API only in Chrome/Edge; it sends audio to Google. Interim results arrive in bursts, so
  "acting before you finish" is most visible on longer sentences.
- One action per utterance; extra words after an executed command are treated as a new command
  only if there are at least two of them.
- Element snapshot is capped at 100 items (viewport first) and 60 chars of text each — deep pages
  need a scroll before "click …" finds below-fold items. Elements inside iframes are not seen.
- Sites with heavy bot protection (Google consent, some search engines in headless mode) may not
  render results; the demo uses Wikipedia, example.com, Hacker News and DuckDuckGo.
- `select_option` matches the option label in code by substring; `switch_tab` cycles.
- Confidence gates are calibrated on `jev-1.13.0`; re-check `T` if you move the model alias.
