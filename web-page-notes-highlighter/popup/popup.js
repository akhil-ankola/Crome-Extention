// popup/popup.js
(async () => {
  // ── State ──────────────────────────────────────────────────
  let currentUrl = '';
  let currentTitle = '';
  let existingNote = null;

  // ── DOM refs ───────────────────────────────────────────────
  const pageTitle = document.getElementById('pageTitle');
  const noteTextarea = document.getElementById('noteTextarea');
  const wordCount = document.getElementById('wordCount');
  const saveBtn = document.getElementById('saveBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const deleteBtn = document.getElementById('deleteBtn');
  const deleteRow = document.getElementById('deleteRow');
  const headerBadge = document.getElementById('headerBadge');
  const badgeCount = document.getElementById('badgeCount');
  const highlightsSummary = document.getElementById('highlightsSummary');
  const hlCount = document.getElementById('hlCount');
  const hlPreview = document.getElementById('hlPreview');
  const viewAllBtn = document.getElementById('viewAllBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const openSidebarBtn = document.getElementById('openSidebarBtn');

  // ── Apply theme ────────────────────────────────────────────
  const settings = await Storage.getSettings();
  if (settings.theme === 'dark') document.body.classList.add('dark');

  // ── Get current tab ────────────────────────────────────────
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentUrl = tab?.url || '';
  currentTitle = tab?.title || '';

  // Clip title for display
  pageTitle.textContent = currentTitle.length > 40
    ? currentTitle.slice(0, 37) + '…'
    : currentTitle;

  // ── Load note ──────────────────────────────────────────────
  existingNote = await Storage.getNote(currentUrl);
  if (existingNote) {
    noteTextarea.value = existingNote.note;
    deleteRow.style.display = 'block';
    saveBtn.textContent = 'Update Note';
  }
  updateWordCount();

  // ── Load highlights ────────────────────────────────────────
  const highlights = await Storage.getHighlightsForUrl(currentUrl);
  if (highlights.length > 0) {
    highlightsSummary.style.display = 'block';
    hlCount.textContent = highlights.length;
    hlPreview.innerHTML = '';
    highlights.slice(0, 3).forEach(h => {
      const div = document.createElement('div');
      div.className = 'hl-item';
      div.textContent = h.text.slice(0, 60) + (h.text.length > 60 ? '…' : '');
      hlPreview.appendChild(div);
    });
  }

  // ── Badge ──────────────────────────────────────────────────
  const totalItems = (existingNote ? 1 : 0) + highlights.length;
  if (totalItems > 0) {
    headerBadge.style.display = 'block';
    badgeCount.textContent = totalItems;
  }

  // ── Word counter ───────────────────────────────────────────
  noteTextarea.addEventListener('input', updateWordCount);

  function updateWordCount() {
    const text = noteTextarea.value.trim();
    const count = text ? text.split(/\s+/).length : 0;
    wordCount.textContent = `${count} word${count !== 1 ? 's' : ''}`;
  }

  // ── Save ───────────────────────────────────────────────────
  saveBtn.addEventListener('click', async () => {
    const text = noteTextarea.value.trim();
    if (!text) { showToast('Write something first!'); return; }

    await Storage.saveNote(currentUrl, currentTitle, text);
    existingNote = true;
    deleteRow.style.display = 'block';
    saveBtn.textContent = 'Update Note';
    chrome.runtime.sendMessage({ action: 'refreshBadge' });
    showToast('Note saved ✓');
  });

  // ── Cancel ─────────────────────────────────────────────────
  cancelBtn.addEventListener('click', () => {
    if (existingNote) {
      noteTextarea.value = existingNote.note || existingNote;
    } else {
      noteTextarea.value = '';
    }
    updateWordCount();
  });

  // ── Delete ─────────────────────────────────────────────────
  deleteBtn.addEventListener('click', async () => {
    if (!confirm('Delete this note?')) return;
    await Storage.deleteNote(currentUrl);
    existingNote = null;
    noteTextarea.value = '';
    updateWordCount();
    deleteRow.style.display = 'none';
    saveBtn.textContent = 'Save Note';
    chrome.runtime.sendMessage({ action: 'refreshBadge' });
    showToast('Note deleted');
  });

  // ── Navigation ─────────────────────────────────────────────
  viewAllBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('notes/notes.html') });
    window.close();
  });

  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  openSidebarBtn.addEventListener('click', () => {
    chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' });
    window.close();
  });

  // ── Toast ──────────────────────────────────────────────────
  function showToast(msg) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
      }, 1800);
    });
  }
})();
