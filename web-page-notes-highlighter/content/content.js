// content/content.js
(function () {
  'use strict';

  // Stable storage key: strip hash, query-string params (WordPress adds
  // ?doing_wp_cron, ?ver, UTM tags etc.), and normalise trailing slash.
  // This ensures the same page always maps to the same storage key
  // regardless of how WordPress/plugins modify the URL between visits.
  function buildPageKey(href) {
    try {
      const u = new URL(href);
      // Keep only origin + pathname, normalised (no trailing slash except root)
      let path = u.origin + u.pathname;
      if (path.length > u.origin.length + 1 && path.endsWith('/')) {
        path = path.slice(0, -1);
      }
      return path;
    } catch (_) {
      return href.split('#')[0].split('?')[0];
    }
  }
  const PAGE_URL = buildPageKey(location.href);
  let sidebarOpen = false;
  let selectionBubble = null;
  let tooltip = null;
  let pendingHighlightRange = null;
  let selectedColor = 'yellow';
  const COLORS = ['yellow', 'green', 'blue', 'pink', 'orange'];

  // ── Extension context guard ────────────────────────────────
  // When the extension is reloaded/updated while the page stays open,
  // chrome.runtime.id becomes undefined and any chrome API call throws
  // "Extension context invalidated." We guard every chrome API call so
  // failures are swallowed silently rather than spamming the console,
  // and a periodic watcher notifies the user to refresh the tab.

  function isContextValid() {
    try {
      // Accessing chrome.runtime.id throws if the context is gone.
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  // Wraps every chrome.storage / chrome.runtime call.
  // Returns the fallback value silently if the context is dead.
  function safeStorageGet(keys, fallback) {
    return new Promise(resolve => {
      if (!isContextValid()) return resolve(fallback);
      try {
        chrome.storage.local.get(keys, data => {
          // chrome.runtime.lastError itself throws if the context dies
          // between the .get() call and this callback firing.
          try { if (chrome.runtime.lastError) return resolve(fallback); }
          catch (_) { return resolve(fallback); }
          resolve(data);
        });
      } catch (_) {
        resolve(fallback);
      }
    });
  }

  function safeStorageSet(items) {
    return new Promise(resolve => {
      if (!isContextValid()) return resolve();
      try {
        chrome.storage.local.set(items, () => {
          // Same race: context may die while the async write is in-flight.
          try { void chrome.runtime.lastError; } catch (_) { /* gone */ }
          resolve();
        });
      } catch (_) {
        resolve();
      }
    });
  }

  function safeSendMessage(msg) {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage(msg);
    } catch (_) { /* context gone — ignore */ }
  }

  // ── Storage helpers ────────────────────────────────────────
  async function getNote() {
    const d = await safeStorageGet('notes', {});
    return ((d.notes || {})[PAGE_URL]) || null;
  }

  async function saveNote(text) {
    const d    = await safeStorageGet('notes', {});
    const notes = d.notes || {};
    const now   = new Date().toISOString();
    const existing = notes[PAGE_URL];
    notes[PAGE_URL] = { title: document.title, note: text, createdAt: existing?.createdAt || now, updatedAt: now };
    await safeStorageSet({ notes });
  }

  async function deleteNote() {
    const d     = await safeStorageGet('notes', {});
    const notes = d.notes || {};
    delete notes[PAGE_URL];
    await safeStorageSet({ notes });
  }

  async function getHighlights() {
    const d = await safeStorageGet('highlights', {});
    return ((d.highlights || {})[PAGE_URL]) || [];
  }

  async function saveHighlight(highlight) {
    const d   = await safeStorageGet('highlights', {});
    const all = d.highlights || {};
    if (!all[PAGE_URL]) all[PAGE_URL] = [];
    highlight.id        = highlight.id        || Date.now().toString();
    highlight.createdAt = highlight.createdAt || new Date().toISOString();
    all[PAGE_URL].push(highlight);
    await safeStorageSet({ highlights: all });
    return highlight.id;
  }

  async function deleteHighlight(id) {
    const d   = await safeStorageGet('highlights', {});
    const all = d.highlights || {};
    if (all[PAGE_URL]) {
      all[PAGE_URL] = all[PAGE_URL].filter(h => h.id !== id);
      if (!all[PAGE_URL].length) delete all[PAGE_URL];
    }
    await safeStorageSet({ highlights: all });
  }

  async function updateHighlight(id, changes) {
    // Merges `changes` (e.g. { note, color }) into the stored highlight object.
    const d   = await safeStorageGet('highlights', {});
    const all = d.highlights || {};
    if (!all[PAGE_URL]) return;
    const idx = all[PAGE_URL].findIndex(h => h.id === id);
    if (idx === -1) return;
    all[PAGE_URL][idx] = { ...all[PAGE_URL][idx], ...changes };
    await safeStorageSet({ highlights: all });
  }

  async function getSettings() {
    const d = await safeStorageGet('settings', {});
    return d.settings || { theme: 'light' };
  }

  function sanitize(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // ── Initialise ─────────────────────────────────────────────
  async function init() {
    const settings = await getSettings();
    if (settings.theme === 'dark') document.body.classList.add('wpn-dark');
    await restoreHighlights();
    injectFloatButton();
    injectSidebar();
    setupSelectionListener();
    setupTooltip();
    updateFloatBtnBadge();
  }

  // ── Highlight Restoration ──────────────────────────────────
  //
  // Problem: many sites (WordPress/Elementor, React SPAs, lazy-loaders)
  // inject their content AFTER document_idle fires. If we only try once
  // at init time the text nodes we need don't exist yet, so indexOf()
  // finds nothing and the highlights appear gone after every refresh.
  //
  // Solution: three-layer approach
  //  1. Try immediately at init (catches static / server-rendered pages).
  //  2. Retry at 500 ms, 1 s, 2 s, 4 s (catches delayed injections).
  //  3. MutationObserver: any time new nodes land in the DOM, re-run
  //     only the highlights that haven't been found yet (cheap — stops
  //     as soon as all highlights are present).

  async function restoreHighlights() {
    const highlights = await getHighlights();
    if (!highlights.length) return;

    // Track which IDs are still missing from the DOM
    const pending = new Set(highlights.map(h => h.id));

    function tryApply() {
      if (!pending.size) return; // all done

      for (const h of highlights) {
        if (!pending.has(h.id)) continue;            // already applied

        // Check if already in DOM (e.g. from a previous attempt)
        if (document.querySelector(`.wpn-highlight[data-id="${h.id}"]`)) {
          pending.delete(h.id);
          continue;
        }

        applyHighlightToDOM(h);

        // If it appeared now, mark as done
        if (document.querySelector(`.wpn-highlight[data-id="${h.id}"]`)) {
          pending.delete(h.id);
        }
      }
    }

    // ── Attempt 1: immediate ────────────────────────────────
    tryApply();
    if (!pending.size) return;

    // ── Attempt 2-5: timed retries (500ms, 1s, 2s, 4s) ────
    const DELAYS = [500, 1000, 2000, 4000];
    for (const delay of DELAYS) {
      await new Promise(r => setTimeout(r, delay));
      tryApply();
      if (!pending.size) {
        return;
      }
    }

    // ── Attempt 6: MutationObserver fallback ───────────────
    // For sites that keep injecting content (infinite scroll, SPAs).
    // Observes the entire body for subtree changes and retries on each
    // batch of mutations. Disconnects once all highlights are restored
    // or after 30 seconds to avoid running forever.
    if (!pending.size) return;

    const observer = new MutationObserver(() => {
      tryApply();
      if (!pending.size) observer.disconnect();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Safety disconnect after 30 s regardless
    setTimeout(() => observer.disconnect(), 30000);
  }

  // ══════════════════════════════════════════════════════════════════
  //  CORE HIGHLIGHTING ENGINE
  //
  //  Two paths:
  //
  //  1. LIVE PATH  — user just selected text; we have a live Range.
  //     highlightLiveRange(range, id, color, note)
  //     Exact, instant, handles every selection type without any
  //     text searching. This is the primary path.
  //
  //  2. RESTORE PATH — page reload; we only have the saved text string.
  //     applyHighlightToDOM(highlight)
  //     Re-searches the page text, builds a Range, then calls
  //     highlightLiveRange() so both paths share the same safe kernel.
  //
  //  Both paths ultimately call wrapTextNode() which ONLY ever wraps
  //  a single text node — never a block element — keeping DOM valid.
  // ══════════════════════════════════════════════════════════════════

  /**
   * highlightLiveRange
   * ------------------
   * Given a live Range (from window.getSelection()), wrap all selected
   * text fragments in highlight <mark> elements.
   *
   * Works for:
   *  - Single word / single line selections
   *  - Entire-element selections (e.g. triple-click on a <p>)
   *  - Multi-paragraph / multi-element selections
   *  - Selections inside nested inline elements (<b>, <i>, <a>, etc.)
   */
  function highlightLiveRange(range, id, color, note) {
    if (!range || range.collapsed) return false;

    const textNodes = getTextNodesInRange(range);
    if (textNodes.length === 0) return false;

    try {
      textNodes.forEach((node, i) => {
        // Default: wrap the entire node text
        let start = 0;
        let end   = node.nodeValue.length;

        // First node: begin at the range's start offset
        if (i === 0 && node === range.startContainer) {
          start = range.startOffset;
        }
        // Last node: stop at the range's end offset
        if (i === textNodes.length - 1 && node === range.endContainer) {
          end = range.endOffset;
        }

        // Skip pure-whitespace fragments (e.g. newlines between block elements)
        if (end > start && node.nodeValue.slice(start, end).trim().length > 0) {
          wrapTextNode(node, start, end, id, color, note);
        }
      });
      return true;
    } catch (err) {
      console.warn('[WPN] highlightLiveRange error:', err);
      return false;
    }
  }

  /**
   * getTextNodesInRange
   * -------------------
   * Returns, in document order, every text node that overlaps the range.
   * Skips our own UI elements and script/style nodes.
   */
  function getTextNodesInRange(range) {
    const root = range.commonAncestorContainer;

    // Fast path: selection entirely within one text node
    if (root.nodeType === Node.TEXT_NODE) {
      return isOwnUINode(root) ? [] : [root];
    }

    const nodes  = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isOwnUINode(node))           return NodeFilter.FILTER_REJECT;
        if (!range.intersectsNode(node)) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  /**
   * wrapTextNode
   * ------------
   * Wraps the character slice [start, end) of a SINGLE text node with
   * a <mark class="wpn-highlight">. Uses splitText() to carve out
   * exactly the selected substring — never touches block parents.
   *
   * Before: [TEXT: "Hello world foo"]
   * After:  [TEXT: "Hello "] [MARK: "world"] [TEXT: " foo"]
   */
  function wrapTextNode(textNode, start, end, id, color, note) {
    if (start >= end) return null;
    start = Math.max(0, start);
    end   = Math.min(textNode.nodeValue.length, end);
    if (start >= end) return null;

    // Carve the tail FIRST so `start` offset stays valid in the remaining node
    if (end < textNode.nodeValue.length) textNode.splitText(end);
    if (start > 0)                       textNode = textNode.splitText(start);

    const mark = document.createElement('mark');
    mark.className    = 'wpn-highlight';
    mark.dataset.id    = id;
    mark.dataset.color = color || 'yellow';
    mark.dataset.note  = note  || '';

    textNode.parentNode.insertBefore(mark, textNode);
    mark.appendChild(textNode);
    return mark;
  }

  // ── isOwnUINode ───────────────────────────────────────────
  function isOwnUINode(node) {
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el) return false;
    if (el.closest('#wpn-sidebar'))           return true;
    if (el.closest('#wpn-float-btn'))         return true;
    if (el.closest('.wpn-selection-bubble'))  return true;
    if (el.closest('.wpn-highlight-dialog'))  return true;
    if (el.closest('.wpn-dialog-overlay'))    return true;
    const tag = el.tagName;
    if (tag && ['SCRIPT','STYLE','NOSCRIPT','IFRAME','TEXTAREA','INPUT'].includes(tag)) return true;
    return false;
  }

  // ══════════════════════════════════════════════════════════════════
  //  RESTORE PATH
  //  Re-locate saved text on the page and re-apply highlighting.
  // ══════════════════════════════════════════════════════════════════

  function getAllContentTextNodes() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isOwnUINode(node)) return NodeFilter.FILTER_REJECT;
        // Don't rewrap already-highlighted nodes
        if (node.parentElement && node.parentElement.classList.contains('wpn-highlight')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function normaliseWS(str) { return str.replace(/\s+/g, ' '); }

  // ── XPath helpers ─────────────────────────────────────────
  // XPath lets us pin-point a text node by its position in the DOM tree.
  // This survives page refreshes because Elementor/WordPress always renders
  // the same DOM structure even though text arrives asynchronously.

  function getXPath(node) {
    // Returns an absolute XPath string for a text node or element.
    if (!node) return '';
    const parts = [];
    let current = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
    while (current && current !== document.body && current.nodeType === Node.ELEMENT_NODE) {
      let idx = 1;
      let sib = current.previousElementSibling;
      while (sib) { if (sib.tagName === current.tagName) idx++; sib = sib.previousElementSibling; }
      parts.unshift(current.tagName.toLowerCase() + '[' + idx + ']');
      current = current.parentNode;
    }
    return '//' + parts.join('/');
  }

  function getTextNodeIndex(textNode) {
    // Which text-node child of its parent is this? (0-based)
    let idx = 0;
    let sib = textNode.previousSibling;
    while (sib) { if (sib.nodeType === Node.TEXT_NODE) idx++; sib = sib.previousSibling; }
    return idx;
  }

  function resolveXPathTextNode(xpath, textNodeIndex) {
    // Walk back from XPath to the specific text node
    try {
      const result = document.evaluate(
        xpath, document.body, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
      const el = result.singleNodeValue;
      if (!el) return null;
      let idx = 0;
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (idx === textNodeIndex) return child;
          idx++;
        }
      }
      return null;
    } catch (_) { return null; }
  }

  // Called right after the user creates a highlight — enriches the stored
  // object with XPath anchors so restore can find it even after a refresh.
  function addXPathAnchor(highlight, range) {
    try {
      const sc = range.startContainer;
      const ec = range.endContainer;
      highlight.anchor = {
        startXPath:     getXPath(sc),
        startTextIdx:   getTextNodeIndex(sc),
        startOffset:    range.startOffset,
        endXPath:       getXPath(ec),
        endTextIdx:     getTextNodeIndex(ec),
        endOffset:      range.endOffset,
      };
    } catch (_) { /* anchor enrichment is best-effort */ }
  }

  // Try to restore from XPath anchor (fast, exact, Elementor-safe)
  function applyHighlightFromAnchor(h) {
    if (!h.anchor) return false;
    try {
      const { startXPath, startTextIdx, startOffset,
              endXPath,   endTextIdx,   endOffset } = h.anchor;
      const startNode = resolveXPathTextNode(startXPath, startTextIdx);
      const endNode   = resolveXPathTextNode(endXPath,   endTextIdx);
      if (!startNode || !endNode) return false;

      const range = document.createRange();
      range.setStart(startNode, Math.min(startOffset, startNode.length));
      range.setEnd(endNode,     Math.min(endOffset,   endNode.length));
      if (range.collapsed) return false;

      highlightLiveRange(range, h.id, h.color, h.note);
      // Verify something was actually marked
      return !!document.querySelector(`.wpn-highlight[data-id="${h.id}"]`);
    } catch (_) { return false; }
  }

  function applyHighlightToDOM(h) {
    if (!h.text || !h.text.trim()) return;

    // ── Strategy 1: XPath anchor (exact, layout-independent) ─
    if (h.anchor && applyHighlightFromAnchor(h)) return;

    // ── Strategy 2: text-search fallback ─────────────────────
    const nodes = getAllContentTextNodes();
    if (nodes.length === 0) return;

    let flatText = '';
    const map    = [];

    for (const node of nodes) {
      const val = node.nodeValue;
      for (let i = 0; i < val.length; i++) {
        map.push({ node, offset: i });
        flatText += val[i];
      }
      flatText += ' ';
      map.push(null);
    }

    const needle   = normaliseWS(h.text.trim());
    const haystack = normaliseWS(flatText);
    const idx      = haystack.indexOf(needle);
    if (idx === -1) return;

    const endIdx = idx + needle.length;

    let si = idx;
    while (si < map.length && map[si] === null) si++;
    if (si >= map.length) return;
    const startEntry = map[si];

    let ei = endIdx - 1;
    while (ei >= 0 && map[ei] === null) ei--;
    if (ei < 0) return;
    const endEntry = map[ei];

    try {
      const range = document.createRange();
      range.setStart(startEntry.node, startEntry.offset);
      range.setEnd(endEntry.node,     endEntry.offset + 1);
      highlightLiveRange(range, h.id, h.color, h.note);
    } catch (err) {
      console.warn('[WPN] applyHighlightToDOM error:', err);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  SELECTION LISTENER + FLOAT BUTTON
  // ══════════════════════════════════════════════════════════════════

  function setupSelectionListener() {
    document.addEventListener('mouseup', e => {
      if (e.target.closest('#wpn-sidebar') ||
          e.target.closest('#wpn-float-btn') ||
          e.target.closest('.wpn-selection-bubble') ||
          e.target.closest('.wpn-highlight-dialog') ||
          e.target.closest('.wpn-dialog-overlay')) return;

      setTimeout(() => {
        const sel  = window.getSelection();
        const text = sel ? sel.toString().trim() : '';
        if (text.length > 0) {
          showSelectionBubble(e.clientX, e.clientY, sel);
          positionAndShowFloatBtn(sel);
        } else {
          removeSelectionBubble();
          hideFloatBtn();
        }
      }, 10);
    });

    document.addEventListener('keyup', e => {
      if (e.target.closest('#wpn-sidebar')) return;
      const sel  = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (text.length > 0) positionAndShowFloatBtn(sel);
      else                  hideFloatBtn();
    });

    document.addEventListener('mousedown', e => {
      if (e.target.closest('.wpn-selection-bubble') ||
          e.target.closest('#wpn-float-btn')) return;
      removeSelectionBubble();
      hideFloatBtn();
    });

    document.addEventListener('selectionchange', () => {
      const sel  = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (text.length === 0) {
        setTimeout(() => {
          const selNow = window.getSelection();
          if (!selNow || selNow.toString().trim().length === 0) hideFloatBtn();
        }, 120);
      }
    });
  }

  function positionAndShowFloatBtn(sel) {
    const btn = document.getElementById('wpn-float-btn');
    if (!btn || !sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const rect  = range.getBoundingClientRect();

    if (!rect || (rect.width === 0 && rect.height === 0)) {
      btn.style.top   = '80px';
      btn.style.right = '24px';
      btn.style.left  = 'auto';
    } else {
      const btnSize = 44;
      const gap     = 10;
      const margin  = 8;
      let left = rect.left + rect.width / 2 - btnSize / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - btnSize - margin));
      let top = rect.bottom + gap + window.scrollY;
      if (rect.bottom + gap + btnSize > window.innerHeight) {
        top = rect.top - btnSize - gap + window.scrollY;
      }
      btn.style.left  = left + 'px';
      btn.style.top   = top  + 'px';
      btn.style.right = 'auto';
    }
    btn.classList.add('visible');
  }

  function hideFloatBtn() {
    const btn = document.getElementById('wpn-float-btn');
    if (btn) btn.classList.remove('visible');
  }

  function showSelectionBubble(x, y, sel) {
    removeSelectionBubble();

    // Capture Range immediately — before any focus change collapses it
    if (sel.rangeCount > 0) {
      pendingHighlightRange = sel.getRangeAt(0).cloneRange();
    }

    const bubble  = document.createElement('div');
    bubble.className = 'wpn-selection-bubble';

    const hlBtn   = document.createElement('button');
    hlBtn.className = 'wpn-bubble-btn highlight';
    hlBtn.innerHTML = '✦ Highlight';

    const noteBtn = document.createElement('button');
    noteBtn.className = 'wpn-bubble-btn';
    noteBtn.innerHTML = '📝 + Note';

    bubble.appendChild(hlBtn);
    bubble.appendChild(noteBtn);
    document.body.appendChild(bubble);
    selectionBubble = bubble;

    const bRect = bubble.getBoundingClientRect();
    let top  = y - 48;
    let left = x - bRect.width / 2;
    if (top < 8) top = y + 20;
    if (left < 8) left = 8;
    if (left + bRect.width > window.innerWidth - 8) left = window.innerWidth - bRect.width - 8;
    bubble.style.top  = top  + 'px';
    bubble.style.left = left + 'px';

    const fullSelectedText = pendingHighlightRange
      ? pendingHighlightRange.toString().trim()
      : sel.toString().trim();

    hlBtn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      showHighlightDialog(fullSelectedText, false);
      removeSelectionBubble();
    });

    noteBtn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      showHighlightDialog(fullSelectedText, true);
      removeSelectionBubble();
    });
  }

  function removeSelectionBubble() {
    if (selectionBubble) { selectionBubble.remove(); selectionBubble = null; }
  }

  // ── Highlight Dialog ───────────────────────────────────────
  function showHighlightDialog(fullText, focusNote) {
    document.querySelector('.wpn-dialog-overlay')?.remove();
    document.querySelector('.wpn-highlight-dialog')?.remove();

    const PREVIEW_LIMIT = 160;
    const previewText = fullText.length > PREVIEW_LIMIT
      ? fullText.slice(0, PREVIEW_LIMIT) + '…'
      : fullText;

    const overlay = document.createElement('div');
    overlay.className = 'wpn-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'wpn-highlight-dialog';
    dialog.innerHTML = `
      <div class="wpn-dialog-title">📝 Save Highlight</div>
      <div class="wpn-dialog-selected">${sanitize(previewText)}</div>
      <div class="wpn-color-row">
        ${COLORS.map(c => `<button class="wpn-color-btn${c === selectedColor ? ' active' : ''}" data-color="${c}" title="${c}"></button>`).join('')}
      </div>
      <textarea class="wpn-dialog-textarea" placeholder="Add a note (optional)…"></textarea>
      <div class="wpn-dialog-actions">
        <button class="wpn-dialog-btn cancel">Cancel</button>
        <button class="wpn-dialog-btn save">Save Highlight</button>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(dialog);

    const textarea = dialog.querySelector('.wpn-dialog-textarea');
    if (focusNote) textarea.focus();

    dialog.querySelectorAll('.wpn-color-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        dialog.querySelectorAll('.wpn-color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedColor = btn.dataset.color;
      });
    });

    const cleanup = () => { overlay.remove(); dialog.remove(); };
    overlay.addEventListener('click', cleanup);
    dialog.querySelector('.cancel').addEventListener('click', cleanup);
    dialog.querySelector('.save').addEventListener('click', async () => {
      const note = textarea.value.trim();
      await doHighlight(fullText, selectedColor, note);
      cleanup();
    });
  }

  // ── doHighlight ────────────────────────────────────────────
  async function doHighlight(text, color, note) {
    const id        = Date.now().toString();
    const highlight = { id, text, color, note, createdAt: new Date().toISOString() };

    let succeeded = false;

    if (pendingHighlightRange) {
      // Enrich with XPath anchor BEFORE the range is consumed.
      // This gives the restore engine a precise location to jump back to
      // on the next page load — independent of text search.
      addXPathAnchor(highlight, pendingHighlightRange);

      // PRIMARY: use the exact live Range from the user's selection
      succeeded = highlightLiveRange(pendingHighlightRange, id, color, note);
      pendingHighlightRange = null;
    }

    if (!succeeded) {
      // FALLBACK: text-search restore path (e.g. context-menu trigger)
      applyHighlightToDOM({ ...highlight });
    }

    // Clear the browser selection overlay
    window.getSelection()?.removeAllRanges();

    await saveHighlight(highlight);
    updateFloatBtnBadge();
    showWpnToast('Highlight saved!');
    safeSendMessage({ action: 'refreshBadge' });

    if (sidebarOpen) renderSidebarHighlights();
  }

  // ── Tooltip ────────────────────────────────────────────────
  function setupTooltip() {
    tooltip = document.createElement('div');
    tooltip.className = 'wpn-tooltip';
    document.body.appendChild(tooltip);

    document.addEventListener('mouseover', e => {
      const hl = e.target.closest('.wpn-highlight');
      if (!hl) return;
      const note = hl.dataset.note;
      const text = hl.textContent.slice(0, 60);
      tooltip.innerHTML = `<div class="wpn-tooltip-text">"${sanitize(text)}"</div>${note ? sanitize(note) : '<i style="color:#666">No note</i>'}`;
      tooltip.classList.add('visible');
    });

    document.addEventListener('mousemove', e => {
      if (tooltip.classList.contains('visible')) {
        tooltip.style.left = Math.min(e.clientX + 12, window.innerWidth - 240) + 'px';
        tooltip.style.top  = (e.clientY - 50) + 'px';
      }
    });

    document.addEventListener('mouseout', e => {
      if (e.target.closest('.wpn-highlight')) tooltip.classList.remove('visible');
    });

    document.addEventListener('click', e => {
      const hl = e.target.closest('.wpn-highlight');
      if (hl) { openSidebar(); highlightFlash(hl); }
    });
  }

  function highlightFlash(el) {
    el.classList.remove('flash');
    requestAnimationFrame(() => el.classList.add('flash'));
    setTimeout(() => el.classList.remove('flash'), 800);
  }

  // ── Floating Button ─────────────────────────────────────────
  function injectFloatButton() {
    const btn = document.createElement('button');
    btn.id = 'wpn-float-btn';
    btn.title = 'Page Notes (Ctrl+Shift+N)';
    btn.textContent = '📝';
    document.body.appendChild(btn);
    btn.addEventListener('click', () => { toggleSidebar(); hideFloatBtn(); });
  }

  async function updateFloatBtnBadge() {
    const btn = document.getElementById('wpn-float-btn');
    if (!btn) return;
    const note       = await getNote();
    const highlights = await getHighlights();
    btn.classList.toggle('has-notes', !!(note || highlights.length > 0));
  }

  // ── Sidebar Injection ──────────────────────────────────────
  function injectSidebar() {
    const sidebar = document.createElement('div');
    sidebar.id = 'wpn-sidebar';
    sidebar.innerHTML = `
      <div class="wpn-sidebar-header">
        <div class="wpn-sidebar-title">📝 Page Notes</div>
        <button class="wpn-sidebar-close" id="wpn-sidebar-close">✕</button>
      </div>
      <div class="wpn-sidebar-body" id="wpn-sidebar-body">
        <div class="wpn-sidebar-note-area" id="wpn-note-section">
          <div class="wpn-section-label">Page Note</div>
          <textarea id="wpn-sidebar-textarea" placeholder="Write a note for this page…"></textarea>
          <div class="wpn-sidebar-note-btns">
            <button class="wpn-sbtn primary" id="wpn-save-note">Save</button>
            <button class="wpn-sbtn secondary" id="wpn-cancel-note">Reset</button>
            <button class="wpn-sbtn danger" id="wpn-delete-note" style="display:none">Delete</button>
          </div>
        </div>
        <div id="wpn-highlights-section">
          <div class="wpn-section-label">Highlights <span id="wpn-hl-badge" style="background:#ede9ff;color:#6c63ff;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:700;margin-left:4px">0</span></div>
          <div class="wpn-hl-list" id="wpn-hl-list"></div>
        </div>
      </div>
      <div class="wpn-sidebar-footer">
        <button class="wpn-footer-link" id="wpn-view-all">View All Notes</button>
        <button class="wpn-footer-link" id="wpn-open-settings">Settings</button>
      </div>
    `;
    document.body.appendChild(sidebar);
    bindSidebarEvents();
  }

  function bindSidebarEvents() {
    document.getElementById('wpn-sidebar-close').addEventListener('click', closeSidebar);
    document.getElementById('wpn-view-all').addEventListener('click', () => safeSendMessage({ action: 'openNotesPage' }));
    document.getElementById('wpn-open-settings').addEventListener('click', () => safeSendMessage({ action: 'openOptions' }));
  }

  function toggleSidebar() { sidebarOpen ? closeSidebar() : openSidebar(); }
  function openSidebar()   { sidebarOpen = true;  document.getElementById('wpn-sidebar').classList.add('open');    loadSidebarData(); }
  function closeSidebar()  { sidebarOpen = false; document.getElementById('wpn-sidebar').classList.remove('open'); }

  async function loadSidebarData() {
    await loadSidebarNote();
    await renderSidebarHighlights();
  }

  async function loadSidebarNote() {
    const note      = await getNote();
    const textarea  = document.getElementById('wpn-sidebar-textarea');
    const deleteBtn = document.getElementById('wpn-delete-note');
    const saveBtn   = document.getElementById('wpn-save-note');
    const cancelBtn = document.getElementById('wpn-cancel-note');

    textarea.value = note ? note.note : '';
    deleteBtn.style.display = note ? 'block' : 'none';

    const newSave   = saveBtn.cloneNode(true);
    const newCancel = cancelBtn.cloneNode(true);
    const newDelete = deleteBtn.cloneNode(true);
    newDelete.style.display = note ? 'block' : 'none';
    saveBtn.replaceWith(newSave);
    cancelBtn.replaceWith(newCancel);
    deleteBtn.replaceWith(newDelete);

    newSave.addEventListener('click', async () => {
      const text = textarea.value.trim();
      if (!text) { showWpnToast('Write something first!'); return; }
      await saveNote(text);
      newDelete.style.display = 'block';
      safeSendMessage({ action: 'refreshBadge' });
      updateFloatBtnBadge();
      showWpnToast('Note saved ✓');
    });
    newCancel.addEventListener('click', () => { textarea.value = note ? note.note : ''; });
    newDelete.addEventListener('click', async () => {
      if (!confirm('Delete page note?')) return;
      await deleteNote();
      textarea.value = '';
      newDelete.style.display = 'none';
      safeSendMessage({ action: 'refreshBadge' });
      updateFloatBtnBadge();
      showWpnToast('Note deleted');
    });
  }

  async function renderSidebarHighlights() {
    const highlights = await getHighlights();
    const list  = document.getElementById('wpn-hl-list');
    const badge = document.getElementById('wpn-hl-badge');
    if (!list) return;

    badge.textContent = highlights.length;
    list.innerHTML    = '';

    if (highlights.length === 0) {
      list.innerHTML = `<div class="wpn-empty-state">No highlights yet.<br>Select text on the page and click ✦ Highlight.</div>`;
      return;
    }

    highlights.forEach(h => {
      const card = document.createElement('div');
      card.className = 'wpn-hl-card';
      card.innerHTML = `
        <div class="wpn-hl-card-text" style="background:${colorHex(h.color)}" title="${sanitize(h.text)}">${sanitize(h.text.length > 200 ? h.text.slice(0, 200) + '…' : h.text)}</div>
        ${h.note ? `<div class="wpn-hl-card-note">"${sanitize(h.note)}"</div>` : ''}
        <div class="wpn-hl-card-meta">
          <span class="wpn-hl-card-date">${formatDate(h.createdAt)}</span>
          <div class="wpn-hl-card-actions">
            <button class="wpn-hl-action-btn" title="Scroll to highlight">🎯</button>
            <button class="wpn-hl-action-btn" title="Edit highlight">✏</button>
            <button class="wpn-hl-action-btn" title="Delete">🗑</button>
          </div>
        </div>
        <!-- Inline edit panel (hidden by default) -->
        <div class="wpn-hl-edit-panel" style="display:none">
          <div class="wpn-hl-edit-label">Note</div>
          <textarea class="wpn-hl-edit-textarea" placeholder="Add or edit note…">${sanitize(h.note || '')}</textarea>
          <div class="wpn-hl-edit-label" style="margin-top:8px">Colour</div>
          <div class="wpn-hl-color-row">
            ${['yellow','green','blue','pink','orange'].map(c =>
              `<button class="wpn-hl-color-dot${c === (h.color||'yellow') ? ' active' : ''}" data-color="${c}" style="background:${colorHex(c)}" title="${c}"></button>`
            ).join('')}
          </div>
          <div class="wpn-hl-edit-actions">
            <button class="wpn-sbtn secondary wpn-hl-cancel-btn">Cancel</button>
            <button class="wpn-sbtn primary wpn-hl-save-btn">Save</button>
          </div>
        </div>
      `;

      // Scroll to
      card.querySelector('[title="Scroll to highlight"]').addEventListener('click', e => {
        e.stopPropagation();
        scrollToHighlight(h.id);
      });

      // ── Edit button — toggle inline panel ──────────────────
      const editBtn   = card.querySelector('[title="Edit highlight"]');
      const editPanel = card.querySelector('.wpn-hl-edit-panel');
      const textarea  = card.querySelector('.wpn-hl-edit-textarea');
      let editColor   = h.color || 'yellow';

      editBtn.addEventListener('click', e => {
        e.stopPropagation();
        const open = editPanel.style.display !== 'none';
        editPanel.style.display = open ? 'none' : 'block';
        if (!open) textarea.focus();
      });

      // Colour dot selection inside edit panel
      card.querySelectorAll('.wpn-hl-color-dot').forEach(dot => {
        dot.addEventListener('click', e => {
          e.stopPropagation();
          card.querySelectorAll('.wpn-hl-color-dot').forEach(d => d.classList.remove('active'));
          dot.classList.add('active');
          editColor = dot.dataset.color;
        });
      });

      // Cancel
      card.querySelector('.wpn-hl-cancel-btn').addEventListener('click', e => {
        e.stopPropagation();
        editPanel.style.display = 'none';
        textarea.value = h.note || '';
        editColor = h.color || 'yellow';
      });

      // Save
      card.querySelector('.wpn-hl-save-btn').addEventListener('click', async e => {
        e.stopPropagation();
        const newNote  = textarea.value.trim();
        const newColor = editColor;

        await updateHighlight(h.id, { note: newNote, color: newColor });

        // Update live <mark> elements on the page
        document.querySelectorAll(`.wpn-highlight[data-id="${h.id}"]`).forEach(mark => {
          mark.dataset.note  = newNote;
          mark.dataset.color = newColor;
          mark.style.background = colorHex(newColor);
        });

        showWpnToast('Highlight updated ✓');
        renderSidebarHighlights();  // re-render to reflect changes
      });

      // ── Delete ─────────────────────────────────────────────
      card.querySelector('[title="Delete"]').addEventListener('click', async e => {
        e.stopPropagation();
        await deleteHighlight(h.id);
        document.querySelectorAll(`.wpn-highlight[data-id="${h.id}"]`).forEach(mark => {
          const parent = mark.parentNode;
          while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
          mark.remove();
        });
        safeSendMessage({ action: 'refreshBadge' });
        updateFloatBtnBadge();
        renderSidebarHighlights();
        showWpnToast('Highlight deleted');
      });

      // Click on card body (not action buttons) = scroll to highlight
      card.addEventListener('click', e => {
        if (!e.target.closest('.wpn-hl-action-btn') && !e.target.closest('.wpn-hl-edit-panel')) {
          scrollToHighlight(h.id);
        }
      });

      list.appendChild(card);
    });
  }

  function scrollToHighlight(id) {
    const el = document.querySelector(`.wpn-highlight[data-id="${id}"]`);
    if (!el) { showWpnToast('Highlight not found on page'); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Flash all fragments that belong to this highlight
    document.querySelectorAll(`.wpn-highlight[data-id="${id}"]`).forEach(highlightFlash);
  }

  function colorHex(color) {
    const map = { yellow: '#ffd60a', green: '#86efac', blue: '#93c5fd', pink: '#f9a8d4', orange: '#fdba74' };
    return map[color] || '#ffd60a';
  }

  // ── Toast ─────────────────────────────────────────────────
  function showWpnToast(msg) {
    let t = document.getElementById('wpn-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'wpn-toast';
      Object.assign(t.style, {
        position: 'fixed', bottom: '80px', right: '24px',
        background: '#1a1918', color: '#f0ece6', padding: '8px 16px',
        borderRadius: '20px', fontSize: '12px', fontFamily: 'Inter, sans-serif',
        fontWeight: '500', zIndex: '2147483647', opacity: '0',
        transition: 'opacity 0.2s ease', pointerEvents: 'none'
      });
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.style.opacity = '0', 2000);
  }

  // ── Message Listener ───────────────────────────────────────
  // Guard the listener — if context is already dead on injection, don't throw.
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!isContextValid()) return;
      if (msg.action === 'toggleSidebar') toggleSidebar();
      if (msg.action === 'saveHighlightFromContext') {
        pendingHighlightRange = null;
        showHighlightDialog(msg.text, true);
      }
    });
  } catch (_) { /* extension already invalidated at registration time */ }

  // ── Context invalidation watcher ──────────────────────────
  // Once the extension is reloaded/updated mid-session, the context
  // becomes invalid. We detect this and show a toast asking the user
  // to refresh — instead of silently throwing on every chrome API call.
  const _contextWatcher = setInterval(() => {
    if (!isContextValid()) {
      clearInterval(_contextWatcher);
      showWpnToast('Extension updated — please refresh the page.');
    }
  }, 3000);

  // ── Init ────────────────────────────────────────────────────
  if (!isContextValid()) {
    console.warn('[WPN] Extension context already invalid at injection — aborting init.');
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
