// content/content.js
(function () {
  'use strict';

  const PAGE_URL = location.href.split('#')[0];
  let sidebarOpen = false;
  let selectionBubble = null;
  let tooltip = null;
  let pendingHighlightRange = null;
  let selectedColor = 'yellow';
  const COLORS = ['yellow', 'green', 'blue', 'pink', 'orange'];

  // ── Storage helpers ────────────────────────────────────────
  async function getNote() {
    return new Promise(resolve =>
      chrome.storage.local.get('notes', d => resolve((d.notes || {})[PAGE_URL] || null))
    );
  }

  async function saveNote(text) {
    return new Promise(resolve =>
      chrome.storage.local.get('notes', d => {
        const notes = d.notes || {};
        const now = new Date().toISOString();
        const existing = notes[PAGE_URL];
        notes[PAGE_URL] = { title: document.title, note: text, createdAt: existing?.createdAt || now, updatedAt: now };
        chrome.storage.local.set({ notes }, resolve);
      })
    );
  }

  async function deleteNote() {
    return new Promise(resolve =>
      chrome.storage.local.get('notes', d => {
        const notes = d.notes || {};
        delete notes[PAGE_URL];
        chrome.storage.local.set({ notes }, resolve);
      })
    );
  }

  async function getHighlights() {
    return new Promise(resolve =>
      chrome.storage.local.get('highlights', d => resolve(((d.highlights || {})[PAGE_URL]) || []))
    );
  }

  async function saveHighlight(highlight) {
    return new Promise(resolve =>
      chrome.storage.local.get('highlights', d => {
        const all = d.highlights || {};
        if (!all[PAGE_URL]) all[PAGE_URL] = [];
        highlight.id = highlight.id || Date.now().toString();
        highlight.createdAt = highlight.createdAt || new Date().toISOString();
        all[PAGE_URL].push(highlight);
        chrome.storage.local.set({ highlights: all }, () => resolve(highlight.id));
      })
    );
  }

  async function deleteHighlight(id) {
    return new Promise(resolve =>
      chrome.storage.local.get('highlights', d => {
        const all = d.highlights || {};
        if (all[PAGE_URL]) {
          all[PAGE_URL] = all[PAGE_URL].filter(h => h.id !== id);
          if (!all[PAGE_URL].length) delete all[PAGE_URL];
        }
        chrome.storage.local.set({ highlights: all }, resolve);
      })
    );
  }

  async function getSettings() {
    return new Promise(resolve =>
      chrome.storage.local.get('settings', d => resolve(d.settings || { theme: 'light' }))
    );
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
  async function restoreHighlights() {
    const highlights = await getHighlights();
    highlights.forEach(h => applyHighlightToDOM(h));
  }

  // ── DOM highlight application ─────────────────────────────
  // Handles both single-node and multi-node (multi-paragraph) selections.
  // Strategy:
  //   1. Collect all visible text nodes in document order.
  //   2. Concatenate their values with a map of node→offset so we can
  //      convert a character position in the flat string back to a
  //      (node, offset) pair.
  //   3. Search the flat string for the target text (normalising
  //      whitespace so paragraph breaks / extra spaces don't block matching).
  //   4. Build a Range from start→end across however many nodes it spans.
  //   5. Wrap each node fragment individually with a highlight <span>.

  function getTextNodes() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.classList && p.classList.contains('wpn-highlight')) return NodeFilter.FILTER_REJECT;
        if (['SCRIPT','STYLE','NOSCRIPT','IFRAME','TEXTAREA','INPUT'].includes(p.tagName))
          return NodeFilter.FILTER_REJECT;
        if (p.closest('#wpn-sidebar') || p.closest('#wpn-float-btn') ||
            p.closest('.wpn-highlight-dialog') || p.closest('.wpn-selection-bubble'))
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // Normalise whitespace for matching: collapse runs of whitespace / newlines
  // to a single space so "foo\n\nbar" matches stored text "foo  bar" etc.
  function normaliseWS(str) {
    return str.replace(/\s+/g, ' ');
  }

  function applyHighlightToDOM(h) {
    if (!h.text || !h.text.trim()) return;

    const nodes   = getTextNodes();
    if (nodes.length === 0) return;

    // Build flat text + a lookup table: for each char position in flatText,
    // which node does it belong to, and at what local offset?
    let flatText = '';
    const map = [];   // map[charIdx] = { node, localOffset }
    for (const node of nodes) {
      const val = node.nodeValue;
      for (let i = 0; i < val.length; i++) {
        map.push({ node, offset: i });
        flatText += val[i];
      }
      // Add a space between nodes so cross-paragraph text can match
      // (the space is virtual — it is not added to any node)
      flatText += ' ';
      map.push(null);   // sentinel for the synthetic space
    }

    // Search normalised flat text for normalised target
    const needle   = normaliseWS(h.text.trim());
    const haystack = normaliseWS(flatText);
    const idx      = haystack.indexOf(needle);
    if (idx === -1) return;   // text not found on this page

    const endIdx = idx + needle.length;

    // Walk back to the first real (non-sentinel) position at or after idx
    let startEntry = map[idx];
    let si = idx;
    while (!startEntry && si < map.length) startEntry = map[++si];
    if (!startEntry) return;

    // Walk back to the last real position at or before endIdx-1
    let endEntry = map[endIdx - 1];
    let ei = endIdx - 1;
    while (!endEntry && ei >= 0) endEntry = map[--ei];
    if (!endEntry) return;

    // Single-node case: use surroundContents for simplicity
    if (startEntry.node === endEntry.node) {
      try {
        const range = document.createRange();
        range.setStart(startEntry.node, startEntry.offset);
        range.setEnd(endEntry.node, endEntry.offset + 1);
        wrapRange(range, h.id, h.color, h.note);
      } catch (_) { /* node may have changed */ }
      return;
    }

    // Multi-node case: collect all nodes involved, wrap each fragment
    // individually so we never call surroundContents across element boundaries.
    const involvedNodes = [];
    let collecting = false;
    for (const node of nodes) {
      if (node === startEntry.node) collecting = true;
      if (collecting) involvedNodes.push(node);
      if (node === endEntry.node) break;
    }

    involvedNodes.forEach((node, i) => {
      try {
        const range = document.createRange();
        if (i === 0) {
          // First node: from startEntry.offset to end of node
          range.setStart(node, startEntry.offset);
          range.setEnd(node, node.nodeValue.length);
        } else if (i === involvedNodes.length - 1) {
          // Last node: from 0 to endEntry.offset + 1
          range.setStart(node, 0);
          range.setEnd(endEntry.node, endEntry.offset + 1);
        } else {
          // Middle nodes: wrap entirely
          range.selectNodeContents(node);
        }
        // Only wrap if the range contains actual non-whitespace text
        if (range.toString().trim().length > 0) {
          wrapRange(range, h.id, h.color, h.note);
        }
      } catch (_) { /* skip nodes that have changed */ }
    });
  }

  // Wraps a range that is guaranteed to be within a single text node.
  // Uses surroundContents — the only DOM method that works cleanly for
  // inline wrapping without restructuring block elements.
  // Never call this on a range that crosses element boundaries.
  function wrapRange(range, id, color, note) {
    const mark = document.createElement('mark');
    mark.className = 'wpn-highlight';
    mark.dataset.id = id;
    mark.dataset.color = color || 'yellow';
    mark.dataset.note = note || '';
    try {
      range.surroundContents(mark);
    } catch (_) {
      // Should not happen since callers guarantee a single-text-node range,
      // but if it does, do nothing — never mutate the DOM in an unknown state.
      return null;
    }
    return mark;
  }

  // ── Selection Listener + Float Button Visibility ─────────────
  function setupSelectionListener() {

    // ── mouseup: primary trigger for mouse-drag selection ────
    document.addEventListener('mouseup', e => {
      // Ignore clicks inside our own UI
      if (e.target.closest('#wpn-sidebar') ||
          e.target.closest('#wpn-float-btn') ||
          e.target.closest('.wpn-selection-bubble') ||
          e.target.closest('.wpn-highlight-dialog') ||
          e.target.closest('.wpn-dialog-overlay')) return;

      // Small delay so the browser finalises the selection first
      setTimeout(() => {
        const sel = window.getSelection();
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

    // ── keyup: keyboard selections (Shift+Arrow, Ctrl+A …) ───
    document.addEventListener('keyup', e => {
      if (e.target.closest('#wpn-sidebar')) return;
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (text.length > 0) {
        positionAndShowFloatBtn(sel);
      } else {
        hideFloatBtn();
      }
    });

    // ── mousedown: click anywhere outside our UI = clear ─────
    document.addEventListener('mousedown', e => {
      if (e.target.closest('.wpn-selection-bubble') ||
          e.target.closest('#wpn-float-btn')) return;
      removeSelectionBubble();
      hideFloatBtn();
    });

    // ── selectionchange: catches Escape, collapses, etc. ─────
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (text.length === 0) {
        // 120 ms delay: give mouseup / click handlers a chance to run first
        // so clicking the float button itself doesn't instantly hide it
        setTimeout(() => {
          const selNow = window.getSelection();
          if (!selNow || selNow.toString().trim().length === 0) {
            hideFloatBtn();
          }
        }, 120);
      }
    });
  }

  // ── Position the float button near the selection, then show it ──
  function positionAndShowFloatBtn(sel) {
    const btn = document.getElementById('wpn-float-btn');
    if (!btn || !sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const rect  = range.getBoundingClientRect();

    // If getBoundingClientRect returns an empty rect (e.g. inside an input),
    // fall back to a safe corner position instead of placing at 0,0.
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      btn.style.top  = '80px';
      btn.style.right = '24px';
      btn.style.left  = 'auto';
    } else {
      const btnSize   = 44;   // matches CSS width/height
      const gap       = 10;   // space between selection bottom and button top
      const margin    = 8;    // minimum distance from viewport edge

      // Horizontal: centre under the selection, clamped to viewport
      let left = rect.left + rect.width / 2 - btnSize / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - btnSize - margin));

      // Vertical: below the selection; if that clips the bottom, go above
      let top = rect.bottom + gap + window.scrollY;
      const topAbove = rect.top - btnSize - gap + window.scrollY;
      if (rect.bottom + gap + btnSize > window.innerHeight) {
        top = topAbove;
      }

      btn.style.left = left + 'px';
      btn.style.top  = top  + 'px';
      btn.style.right = 'auto';  // clear any previous right value
    }

    btn.classList.add('visible');
  }

  function showFloatBtn() {
    const btn = document.getElementById('wpn-float-btn');
    if (btn) btn.classList.add('visible');
  }

  function hideFloatBtn() {
    const btn = document.getElementById('wpn-float-btn');
    if (btn) btn.classList.remove('visible');
  }

  function showSelectionBubble(x, y, sel) {
    removeSelectionBubble();
    const bubble = document.createElement('div');
    bubble.className = 'wpn-selection-bubble';

    const hlBtn = document.createElement('button');
    hlBtn.className = 'wpn-bubble-btn highlight';
    hlBtn.innerHTML = '✦ Highlight';

    const noteBtn = document.createElement('button');
    noteBtn.className = 'wpn-bubble-btn';
    noteBtn.innerHTML = '📝 + Note';

    bubble.appendChild(hlBtn);
    bubble.appendChild(noteBtn);
    document.body.appendChild(bubble);
    selectionBubble = bubble;

    // Position above selection
    const bRect = bubble.getBoundingClientRect();
    let top = y - 48;
    let left = x - bRect.width / 2;
    if (top < 8) top = y + 20;
    if (left < 8) left = 8;
    if (left + bRect.width > window.innerWidth - 8) left = window.innerWidth - bRect.width - 8;

    bubble.style.top = top + 'px';
    bubble.style.left = left + 'px';

    // Save range before it might be cleared
    pendingHighlightRange = sel.getRangeAt(0).cloneRange();

    hlBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      // Use the cloned range to extract full text — sel may be gone by now
      const fullSelectedText = pendingHighlightRange
        ? pendingHighlightRange.toString().trim()
        : sel.toString().trim();
      showHighlightDialog(fullSelectedText, false);
      removeSelectionBubble();
    });

    noteBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const fullSelectedText = pendingHighlightRange
        ? pendingHighlightRange.toString().trim()
        : sel.toString().trim();
      showHighlightDialog(fullSelectedText, true);
      removeSelectionBubble();
    });
  }

  function removeSelectionBubble() {
    if (selectionBubble) { selectionBubble.remove(); selectionBubble = null; }
  }

  // ── Highlight Dialog ───────────────────────────────────────
  // `fullText` is always the complete selected string — never truncated.
  // Truncation only happens in the *preview label* inside the dialog UI.
  function showHighlightDialog(fullText, focusNote) {
    // Remove any existing dialog
    document.querySelector('.wpn-dialog-overlay')?.remove();
    document.querySelector('.wpn-highlight-dialog')?.remove();

    // Preview shown in the dialog: capped at 160 chars for display only.
    // The original fullText is kept in the JS closure and saved intact.
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

    // Color selection
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
      // Pass fullText — the complete, untruncated selection string
      await doHighlight(fullText, selectedColor, note);
      cleanup();
    });
  }

  async function doHighlight(text, color, note) {
    const id = Date.now().toString();
    const highlight = { id, text, color, note, createdAt: new Date().toISOString() };

    if (pendingHighlightRange && isSingleTextNodeRange(pendingHighlightRange)) {
      // Range stays inside one text node — safe to wrap directly with no DOM surgery.
      try {
        wrapRange(pendingHighlightRange, id, color, note);
      } catch (_) {
        applyHighlightToDOM({ ...highlight });
      }
    } else {
      // Multi-paragraph or multi-element range: applyHighlightToDOM wraps each
      // text node fragment individually, so block elements (<p>, <div> …) are
      // NEVER placed inside a <mark>. This is the only safe path for complex ranges.
      applyHighlightToDOM({ ...highlight });
    }
    pendingHighlightRange = null;

    await saveHighlight(highlight);
    updateFloatBtnBadge();
    showWpnToast('Highlight saved!');
    chrome.runtime.sendMessage({ action: 'refreshBadge' });

    // Refresh sidebar if open
    if (sidebarOpen) renderSidebarHighlights();
  }

  // Returns true only when a range starts and ends in the same text node.
  // Only these ranges can be safely wrapped with a single <mark> via surroundContents.
  function isSingleTextNodeRange(range) {
    return (
      range.startContainer === range.endContainer &&
      range.startContainer.nodeType === Node.TEXT_NODE
    );
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
        tooltip.style.top = (e.clientY - 50) + 'px';
      }
    });

    document.addEventListener('mouseout', e => {
      if (e.target.closest('.wpn-highlight')) tooltip.classList.remove('visible');
    });

    document.addEventListener('click', e => {
      const hl = e.target.closest('.wpn-highlight');
      if (hl) {
        openSidebar();
        highlightFlash(hl);
      }
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
    btn.addEventListener('click', () => {
      toggleSidebar();
      hideFloatBtn();
    });
  }

  async function updateFloatBtnBadge() {
    const btn = document.getElementById('wpn-float-btn');
    if (!btn) return;
    const note = await getNote();
    const highlights = await getHighlights();
    if (note || highlights.length > 0) {
      btn.classList.add('has-notes');
    } else {
      btn.classList.remove('has-notes');
    }
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
    document.getElementById('wpn-view-all').addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'openNotesPage' });
    });
    document.getElementById('wpn-open-settings').addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'openOptions' });
    });
  }

  // ── Sidebar Open / Close ────────────────────────────────────
  function toggleSidebar() { sidebarOpen ? closeSidebar() : openSidebar(); }
  function openSidebar() { sidebarOpen = true; document.getElementById('wpn-sidebar').classList.add('open'); loadSidebarData(); }
  function closeSidebar() { sidebarOpen = false; document.getElementById('wpn-sidebar').classList.remove('open'); }

  async function loadSidebarData() {
    await loadSidebarNote();
    await renderSidebarHighlights();
  }

  async function loadSidebarNote() {
    const note = await getNote();
    const textarea = document.getElementById('wpn-sidebar-textarea');
    const deleteBtn = document.getElementById('wpn-delete-note');
    const saveBtn = document.getElementById('wpn-save-note');
    const cancelBtn = document.getElementById('wpn-cancel-note');

    textarea.value = note ? note.note : '';

    if (note) {
      deleteBtn.style.display = 'block';
    } else {
      deleteBtn.style.display = 'none';
    }

    // Remove old listeners by replacing elements
    const newSave = saveBtn.cloneNode(true);
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
      chrome.runtime.sendMessage({ action: 'refreshBadge' });
      updateFloatBtnBadge();
      showWpnToast('Note saved ✓');
    });

    newCancel.addEventListener('click', () => {
      textarea.value = note ? note.note : '';
    });

    newDelete.addEventListener('click', async () => {
      if (!confirm('Delete page note?')) return;
      await deleteNote();
      textarea.value = '';
      newDelete.style.display = 'none';
      chrome.runtime.sendMessage({ action: 'refreshBadge' });
      updateFloatBtnBadge();
      showWpnToast('Note deleted');
    });
  }

  async function renderSidebarHighlights() {
    const highlights = await getHighlights();
    const list = document.getElementById('wpn-hl-list');
    const badge = document.getElementById('wpn-hl-badge');
    if (!list) return;

    badge.textContent = highlights.length;
    list.innerHTML = '';

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
            <button class="wpn-hl-action-btn" title="Delete">🗑</button>
          </div>
        </div>
      `;

      // Scroll to
      card.querySelector('[title="Scroll to highlight"]').addEventListener('click', () => scrollToHighlight(h.id));

      // Delete
      card.querySelector('[title="Delete"]').addEventListener('click', async () => {
        await deleteHighlight(h.id);
        // Remove span from DOM
        const span = document.querySelector(`.wpn-highlight[data-id="${h.id}"]`);
        if (span) {
          const parent = span.parentNode;
          while (span.firstChild) parent.insertBefore(span.firstChild, span);
          span.remove();
        }
        chrome.runtime.sendMessage({ action: 'refreshBadge' });
        updateFloatBtnBadge();
        renderSidebarHighlights();
        showWpnToast('Highlight deleted');
      });

      // Click to scroll
      card.addEventListener('click', e => {
        if (!e.target.closest('.wpn-hl-action-btn')) scrollToHighlight(h.id);
      });

      list.appendChild(card);
    });
  }

  function scrollToHighlight(id) {
    const el = document.querySelector(`.wpn-highlight[data-id="${id}"]`);
    if (!el) { showWpnToast('Highlight not found on page'); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    highlightFlash(el);
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
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'toggleSidebar') toggleSidebar();
    if (msg.action === 'saveHighlightFromContext') {
      pendingHighlightRange = null; // context menu won't have range
      showHighlightDialog(msg.text, true);
    }
  });

  // ── Init ────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
