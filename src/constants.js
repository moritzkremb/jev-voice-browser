/**
 * ONE reviewable place for everything Jev sees and every threshold the policy uses.
 *
 * Jev (TypeSafe "System One") does not generate text. Each request carries the
 * current `state` (transcript + page snapshot) and a fan-out of typed questions
 * that are answered independently and in parallel. Code owns control flow.
 *
 * Rules applied here (from docs.typesafe.ai):
 *  - question ids are NOT sent to the model, so every `instructions` is a complete question
 *  - reference state with backticked paths (`transcript`, `page.site`, `elements`)
 *  - Choice options use the same contrastive shape {what, not_for, examples}
 *  - always include a `none` option; never ask Jev to count or generate
 */

export const MODEL = "jev-1.13.0"; // pinned: aliases move on release, thresholds below were tuned on this version

export const PRICE_PER_M_INPUT_TOKENS_USD = 0.042; // output tokens are free

// ---------------------------------------------------------------------------
// Perception limits (state size hurts accuracy + latency; keep it small)
// ---------------------------------------------------------------------------
export const MAX_ELEMENTS = 100; // hard cap on elements sent to Jev (255 is the Choice limit; latency grows with tokens)
export const MAX_ELEMENT_TEXT = 60; // chars per element label
export const MAX_STATE_CHARS = 24_000; // ~6k tokens; far below the 32k-token state limit
export const MAX_TRANSCRIPT_CHARS = 400;
// Conversation context sent with every request: the page before the last navigation and the
// last few executed actions (what was said, what was done, what happened). Lets Jev resolve
// "go back to the results", "the other one", "no, not that one", "open the documentation" (of the
// thing I just opened). Small on purpose — irrelevant state costs accuracy.
export const MAX_CONTEXT_ACTIONS = 3;

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
export const DEBOUNCE_MS = 200; // wait this long after the last transcript update before asking Jev
export const MAX_INFLIGHT = 2; // overlapping Jev requests allowed; older ones are cancelled with AbortSignal
export const SILENCE_COMPLETE_MS = 900; // no new words for this long => treat command as complete
// Intents that carry free text (a query or text to type) cannot be acted on mid-sentence — "search
// for alan" is a complete-sounding command but the payload may still be growing. They wait for the
// recognizer's final result or this much silence.
export const PAYLOAD_SILENCE_MS = 600;
export const PAYLOAD_INTENTS = new Set(["search_web", "type_into_field", "select_option"]);
export const HIGHLIGHT_MS = 600; // element flash on the controlled page
export const CANDIDATE_TTL_MS = 8000; // numbered overlays stay this long
export const CONFIRMATION_TTL_MS = 10_000; // destructive actions can only be confirmed within this window

// ---------------------------------------------------------------------------
// Execution policy thresholds (the "why did it act / wait" numbers shown in the UI)
// ---------------------------------------------------------------------------
export const T = {
  intentConfidence: 0.55, // `intent` Choice confidence needed to act at all
  complete: 0.6, // `complete` Noul: user has finished the command (bypassed after SILENCE_COMPLETE_MS)
  isCommand: 0.5, // `is_command` Noul: user is addressing the browser at all
  destructive: 0.5, // `destructive` Noul above this => needs spoken confirmation
  targetConfidence: 0.45, // `target` Choice below this => show numbered candidate overlays instead of clicking
  targetTopProb: 0.35, // and the winning element must have at least this probability
  spanConfidence: 0.35, // `text_span` / `url_span` picks below this fall back to the heuristic candidate
  candidateCount: 3, // how many candidates to overlay when target is ambiguous
  correction: 0.6, // `is_correction` Noul: user is undoing / redirecting the previous action ("no, not that one")
};

export const TARGET_INTENTS = new Set(["click_element", "type_into_field", "select_option"]);

// ---------------------------------------------------------------------------
// Sites (code owns URLs; Jev only picks the name)
// ---------------------------------------------------------------------------
export const SITE_HOME = {
  google: "https://www.google.com/",
  duckduckgo: "https://duckduckgo.com/",
  youtube: "https://www.youtube.com/",
  wikipedia: "https://en.wikipedia.org/wiki/Main_Page",
  github: "https://github.com/",
  amazon: "https://www.amazon.com/",
  reddit: "https://www.reddit.com/",
  twitter_x: "https://x.com/",
  hacker_news: "https://news.ycombinator.com/",
  example_com: "https://example.com/",
};

// Search URL templates; `%s` is replaced with the URL-encoded query.
export const SITE_SEARCH = {
  google: "https://www.google.com/search?q=%s",
  duckduckgo: "https://duckduckgo.com/?q=%s",
  the_web: "https://duckduckgo.com/?q=%s",
  youtube: "https://www.youtube.com/results?search_query=%s",
  wikipedia: "https://en.wikipedia.org/w/index.php?search=%s",
  github: "https://github.com/search?q=%s&type=repositories",
  amazon: "https://www.amazon.com/s?k=%s",
  reddit: "https://www.reddit.com/search/?q=%s",
  twitter_x: "https://x.com/search?q=%s",
  hacker_news: "https://hn.algolia.com/?q=%s",
};

export const DEFAULT_SEARCH_ENGINE = "duckduckgo";

// ---------------------------------------------------------------------------
// Questions. All are asked in ONE request per transcript update (speculative fan-out).
// ---------------------------------------------------------------------------

export const INTENT_CRITERIA = {
  navigate_url: {
    what: "Open a specific website or URL by name (go to / open / visit / take me to <site>)",
    not_for: "Searching for a topic; clicking something already on the page",
    examples: ["go to wikipedia", "open youtube", "take me to github.com", "visit example dot com"],
  },
  search_web: {
    what: "Search for a topic or phrase (search for / look up / google / find <query>), on the web or on a named site",
    not_for: "Typing into a specific named field without searching; opening a site's homepage",
    examples: ["search for alan turing", "look up typesafe jev", "google cheap flights", "search wikipedia for cats"],
  },
  click_element: {
    what: "Click / press / open / select / choose a link, button, tab, result or item that is on the current page",
    not_for: "Opening a website by name; typing text",
    examples: ["click the first result", "click sign in", "open the second link", "press the more information link"],
  },
  type_into_field: {
    what: "Type or enter specific text into an input box, search box or text field on the page",
    not_for: "Running a search on a search engine (that is search_web); pressing enter alone",
    examples: ["type hello world into the search box", "enter my email", "write good morning in the comment box"],
  },
  select_option: {
    what: "Choose an option from a dropdown / select menu",
    not_for: "Clicking a link or button",
    examples: ["select english from the language dropdown", "choose the large size"],
  },
  press_enter: {
    what: "Press the Enter / Return key, or submit what was typed",
    not_for: "Typing text; clicking a named button",
    examples: ["press enter", "hit enter", "submit"],
  },
  scroll_down: {
    what: "Scroll / move down the page",
    not_for: "Scrolling up; navigating",
    examples: ["scroll down", "scroll down a bit", "go to the bottom", "page down"],
  },
  scroll_up: {
    what: "Scroll / move up the page",
    not_for: "Scrolling down",
    examples: ["scroll up", "back to the top", "page up"],
  },
  go_back: {
    what: "Go back to the previous page in history (back / go back / undo that / previous page)",
    not_for: "Scrolling up; closing a tab",
    examples: ["go back", "undo", "back", "previous page"],
  },
  go_forward: {
    what: "Go forward in history",
    not_for: "Scrolling down",
    examples: ["go forward", "forward"],
  },
  reload: {
    what: "Reload / refresh the current page",
    not_for: "Navigating elsewhere",
    examples: ["reload", "refresh the page"],
  },
  open_new_tab: {
    what: "Open a new empty tab",
    not_for: "Opening a website by name in the current tab",
    examples: ["open a new tab", "new tab"],
  },
  close_tab: {
    what: "Close the current tab",
    not_for: "Going back",
    examples: ["close this tab", "close tab"],
  },
  switch_tab: {
    what: "Switch to another / the next / the previous tab",
    not_for: "Opening or closing tabs",
    examples: ["next tab", "switch tab", "go to the other tab"],
  },
  confirm: {
    what: "Approve a pending action the browser asked to confirm (yes / confirm / do it / go ahead)",
    not_for: "New commands",
    examples: ["confirm", "yes do it", "go ahead"],
  },
  cancel: {
    what: "Cancel / never mind / stop the pending action",
    not_for: "Going back in history",
    examples: ["cancel", "never mind", "stop"],
  },
  none: {
    what: "Not a browser command, or nothing recognizable yet (fragment, chit-chat, silence, filler)",
    not_for: "Anything that clearly matches another option",
    examples: ["um", "okay so", "what do you think", "the weather is nice"],
  },
};

export const SITE_CRITERIA = {
  google: "Google (google, google it)",
  duckduckgo: "DuckDuckGo",
  the_web: "A general web search with no site named (search the web, look it up online)",
  youtube: "YouTube (videos)",
  wikipedia: "Wikipedia (the encyclopedia)",
  github: "GitHub (code, repositories)",
  amazon: "Amazon (shopping)",
  reddit: "Reddit",
  twitter_x: "Twitter / X",
  hacker_news: "Hacker News (news.ycombinator.com, hn)",
  example_com: "example.com / example dot com",
  other_named_site: "Some other website named explicitly in `transcript` (a domain or brand not listed above)",
  none: "No website or search engine is mentioned in `transcript`",
};

export const QUESTIONS = {
  intent: {
    instructions: {
      question: "Which browser action does the user ask for in `transcript`?",
      focus:
        "Judge the words said so far. If the sentence is unfinished, pick the action the words already commit to; if no action is recognizable pick none. `page` and `elements` describe what is currently on screen. `context.previous_page` and `context.recent_actions` (most recent first) say where the user just came from and what was just done: 'back to the results' after clicking a search result is go_back; 'the other one' or 'not that one' after a click is click_element on a different element.",
    },
    criteria: INTENT_CRITERIA,
  },

  target: {
    instructions: {
      question:
        "Which element in `elements` is the one the user refers to in `transcript` (the thing to click, type into or select)? Each line of `elements` starts with the element id (e.g. e07), then its role and visible text; the options are those ids.",
      focus:
        "Match by the element's visible text, role and position words like first/second/top (lines are in visual order, top of page first). Use `context.recent_actions` for relative references: 'the other one' / 'the next one' / 'not that one' mean an element other than the target of the most recent action; 'open its documentation' means the docs of the page or item just opened. Pick none if the command does not refer to any element on this page, or if the referenced element is not in the list.",
    },
    // criteria are built per request from the element list + none
  },

  site: {
    instructions: {
      question: "Which website or search engine does the user name in `transcript`?",
      focus: "Only what is explicitly said. Pick none if no site is named.",
    },
    criteria: SITE_CRITERIA,
  },

  complete: {
    instructions: {
      question:
        "Has the user finished saying the command in `transcript`, so it can be executed now without waiting for more words?",
      focus:
        "Speech arrives word by word. A command is complete when its verb and any required object are present (a site for go to, a query for search for, an element for click, text for type).",
    },
    criteria: {
      true: {
        what: "Complete, actionable command",
        examples: ["scroll down", "go back", "go to wikipedia", "search for alan turing", "click the first result"],
      },
      false: {
        what: "Cut off before the required object; more words are clearly coming",
        examples: ["go to", "search for", "click the", "type", "open the", "scroll"],
      },
    },
  },

  is_command: {
    instructions: {
      question:
        "Is `transcript` an instruction addressed to a web browser (navigate, search, click, type, scroll, tabs, confirm/cancel)?",
      focus:
        "Chit-chat, narration, talking to another person, or a stray fragment is not a command. A reaction to what the browser just did in `context.recent_actions` ('no, not that one', 'undo that', 'wrong link', 'yes confirm') IS addressed to the browser.",
    },
    criteria: {
      true: {
        what: "An imperative aimed at the browser, or a correction / confirmation of its last action",
        examples: ["scroll down", "go to youtube", "click sign in", "no not that one", "undo that", "confirm"],
      },
      false: {
        what: "Not directed at the browser",
        examples: ["I think we should get lunch", "um so yeah", "this is the demo", "what did you say"],
      },
    },
  },

  destructive: {
    instructions: {
      question:
        "Would carrying out the action in `transcript` on this `page` submit a form, place an order, pay, delete, send a message, post publicly, log out, or otherwise do something hard to undo?",
      focus: "Navigating, scrolling, reading, clicking links and typing into a box are NOT destructive.",
    },
    criteria: {
      true: {
        what: "Irreversible side effect",
        examples: ["click buy now", "delete this repository", "send the message", "post the comment", "click checkout"],
      },
      false: {
        what: "Reversible / read-only",
        examples: ["scroll down", "go to wikipedia", "click the first result", "type hello in the search box"],
      },
    },
  },

  scroll_amount: {
    instructions: {
      question: "How far does the user want to scroll according to `transcript`?",
      focus: "Only relevant when scrolling; default is one screen when nothing is specified.",
    },
    criteria: [
      { what: "A little: a few lines (a bit, slightly, a little)" },
      { what: "One screen / one page, or no amount specified" },
      { what: "All the way to the end: the very top or the very bottom" },
    ],
  },

  text_span: {
    instructions: {
      question:
        "Which option is exactly the text the user wants typed or searched, as spoken in `transcript`? Options are verbatim candidate spans.",
      focus:
        "Choose the span that contains the payload text only, without the command words (type, search for, into the search box). Pick none if nothing should be typed.",
    },
  },

  url_span: {
    instructions: {
      question: "Which option is the web address (domain) the user wants to open, as spoken in `transcript`?",
      focus: "Pick none if no address is mentioned.",
    },
  },

  // Only asked when `context.recent_actions` is non-empty.
  is_correction: {
    instructions: {
      question:
        "Is the user in `transcript` saying that the most recent action in `context.recent_actions` was wrong and should be reversed or redirected?",
      focus:
        "A correction reacts to what just happened ('no', 'not that one', 'wrong link', 'undo that', 'the other one', 'I meant the second one'). A fresh command that merely follows the previous action is not a correction.",
    },
    criteria: {
      true: {
        what: "Rejects or redirects the previous action",
        examples: ["no not that one", "wrong one, go back", "undo that", "I meant the other link", "not that, the second one"],
      },
      false: {
        what: "A new command or a continuation, satisfied with the previous action",
        examples: ["scroll down", "now click the comments", "open the documentation", "search for cats"],
      },
    },
  },

  tab_direction: {
    instructions: {
      question: "When switching tabs, which tab does `transcript` refer to?",
    },
    criteria: {
      next: "The next tab / the other tab / switch tab with no direction",
      previous: "The previous tab / the tab before / last tab",
      first: "The first tab",
      none: "Not about switching tabs",
    },
  },
};
