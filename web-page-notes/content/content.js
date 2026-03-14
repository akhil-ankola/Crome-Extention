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

  function applyHighlightToDOM(h) {
    // Walk all text nodes and find matching text to wrap
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.classList && p.classList.contains('wpn-highlight')) return NodeFilter.FILTER_REJECT;
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME'].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.closest('#wpn-sidebar') || p.closest('#wpn-float-btn')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textToFind = h.text.trim();
    if (!textToFind) return;

    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);

    // Rebuild full text from body for finding position
    let found = false;
    for (const textNode of nodes) {
      if (found) break;
      const idx = textNode.nodeValue.indexOf(textToFind);
      if (idx === -1) continue;

      try {
        const range = document.createRange();
        range.setStart(textNode, idx);
        range.setEnd(textNode, idx + textToFind.length);
        wrapRange(range, h.id, h.color, h.note);
        found = true;
      } catch (_) { /* ignore */ }
    }
  }

  function wrapRange(range, id, color, note) {
    const span = document.createElement('span');
    span.className = 'wpn-highlight';
    span.dataset.id = id;
    span.dataset.color = color || 'yellow';
    span.dataset.note = note || '';
    try { range.surroundContents(span); } catch (_) { /* complex range — skip */ }
    return span;
  }

  // ── Selection Bubble ───────────────────────────────────────
  function setupSelectionListener() {
    document.addEventListener('mouseup', e => {
      if (e.target.closest('#wpn-sidebar') || e.target.closest('#wpn-float-btn') ||
          e.target.closest('.wpn-highlight-dialog') || e.target.closest('.wpn-dialog-overlay')) return;
      
      setTimeout(() => {
        const sel = window.getSelection();
        if (sel && sel.toString().trim().length > 2) {
          showSelectionBubble(e.clientX, e.clientY, sel);
        } else {
          removeSelectionBubble();
        }
      }, 10);
    });

    document.addEventListener('mousedown', e => {
      if (!e.target.closest('.wpn-selection-bubble')) removeSelectionBubble();
    });
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
      showHighlightDialog(sel.toString().trim(), false);
      removeSelectionBubble();
    });

    noteBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      showHighlightDialog(sel.toString().trim(), true);
      removeSelectionBubble();
    });
  }

  function removeSelectionBubble() {
    if (selectionBubble) { selectionBubble.remove(); selectionBubble = null; }
  }

  // ── Highlight Dialog ───────────────────────────────────────
  function showHighlightDialog(text, focusNote) {
    // Remove any existing
    document.querySelector('.wpn-dialog-overlay')?.remove();
    document.querySelector('.wpn-highlight-dialog')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'wpn-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'wpn-highlight-dialog';
    dialog.innerHTML = `
      <div class="wpn-dialog-title">📝 Save Highlight</div>
      <div class="wpn-dialog-selected">${sanitize(text.slice(0, 120))}${text.length > 120 ? '…' : ''}</div>
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
      await doHighlight(text, selectedColor, note);
      cleanup();
    });
  }

  async function doHighlight(text, color, note) {
    const id = Date.now().toString();
    const highlight = { id, text, color, note, createdAt: new Date().toISOString() };

    if (pendingHighlightRange) {
      try {
        wrapRange(pendingHighlightRange, id, color, note);
      } catch (_) {
        // Fallback: search and apply
        applyHighlightToDOM({ ...highlight });
      }
      pendingHighlightRange = null;
    } else {
      applyHighlightToDOM({ ...highlight });
    }

    await saveHighlight(highlight);
    updateFloatBtnBadge();
    showWpnToast('Highlight saved!');
    chrome.runtime.sendMessage({ action: 'refreshBadge' });

    // Refresh sidebar if open
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
    btn.addEventListener('click', toggleSidebar);
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
        <div class="wpn-hl-card-text" style="background:${colorHex(h.color)}">${sanitize(h.text.slice(0, 100))}${h.text.length > 100 ? '…' : ''}</div>
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
        borderRadius: '20px', fontSize: '12px', fontFamily: 'DM Sans, sans-serif',
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
