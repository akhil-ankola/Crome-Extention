// notes/notes.js
(async () => {
  // ── Theme ──────────────────────────────────────────────────
  const settings = await Storage.getSettings();
  if (settings.theme === 'dark') document.body.classList.add('dark');

  // ── State ──────────────────────────────────────────────────
  let allNotes = {};
  let allHighlights = {};
  let editingUrl = null;
  let activeTab = 'notes';
  let searchTerm = '';

  const colorHex = {
    yellow: '#ffd60a', green: '#86efac', blue: '#93c5fd',
    pink: '#f9a8d4', orange: '#fdba74'
  };

  // ── Load Data ──────────────────────────────────────────────
  async function loadData() {
    allNotes = await Storage.getNotes();
    allHighlights = await Storage.getHighlights();
    updateStats();
    render();
  }

  function updateStats() {
    const noteCount = Object.keys(allNotes).length;
    let hlCount = 0;
    Object.values(allHighlights).forEach(arr => hlCount += arr.length);
    const pages = new Set([...Object.keys(allNotes), ...Object.keys(allHighlights)]).size;

    document.getElementById('totalNotes').textContent = noteCount;
    document.getElementById('totalHighlights').textContent = hlCount;
    document.getElementById('totalPages').textContent = pages;
  }

  // ── Render ─────────────────────────────────────────────────
  function render() {
    activeTab === 'notes' ? renderNotes() : renderHighlights();
  }

  function renderNotes() {
    const list = document.getElementById('notesList');
    const empty = document.getElementById('notesEmpty');
    list.innerHTML = '';

    const entries = Object.entries(allNotes).filter(([url, note]) => {
      if (!searchTerm) return true;
      const s = searchTerm.toLowerCase();
      return url.toLowerCase().includes(s) ||
             (note.title || '').toLowerCase().includes(s) ||
             (note.note || '').toLowerCase().includes(s);
    });

    if (entries.length === 0) { empty.style.display = 'block'; return; }
    empty.style.display = 'none';

    entries.sort((a, b) => (b[1].updatedAt || '') > (a[1].updatedAt || '') ? 1 : -1);

    entries.forEach(([url, note]) => {
      const card = document.createElement('div');
      card.className = 'note-card';
      card.innerHTML = `
        <div class="note-card-title">${sanitize(note.title || 'Untitled Page')}</div>
        <a class="note-card-url" href="${sanitize(url)}" target="_blank">${sanitize(truncate(url, 55))}</a>
        <div class="note-card-preview">${sanitize(note.note || '')}</div>
        <div class="note-card-meta">Updated ${Storage.formatDate(note.updatedAt)}</div>
        <div class="note-card-actions">
          <button class="card-btn accent" data-action="open" data-url="${sanitize(url)}">🔗 Open</button>
          <button class="card-btn" data-action="edit" data-url="${sanitize(url)}">✏ Edit</button>
          <button class="card-btn danger" data-action="delete" data-url="${sanitize(url)}">🗑</button>
        </div>
      `;
      list.appendChild(card);
    });

    list.querySelectorAll('.card-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        const url = btn.dataset.url;
        const action = btn.dataset.action;
        if (action === 'open') chrome.tabs.create({ url });
        if (action === 'edit') openEditModal(url);
        if (action === 'delete') {
          if (!confirm('Delete this note?')) return;
          await Storage.deleteNote(url);
          await loadData();
        }
      });
    });
  }

  function renderHighlights() {
    const list = document.getElementById('highlightsList');
    const empty = document.getElementById('hlEmpty');
    list.innerHTML = '';

    const entries = [];
    Object.entries(allHighlights).forEach(([url, hls]) => {
      hls.forEach(h => entries.push({ url, ...h }));
    });

    const filtered = entries.filter(h => {
      if (!searchTerm) return true;
      const s = searchTerm.toLowerCase();
      return (h.text || '').toLowerCase().includes(s) ||
             (h.note || '').toLowerCase().includes(s) ||
             h.url.toLowerCase().includes(s);
    });

    if (filtered.length === 0) { empty.style.display = 'block'; return; }
    empty.style.display = 'none';

    filtered.sort((a, b) => (b.createdAt || '') > (a.createdAt || '') ? 1 : -1);

    filtered.forEach(h => {
      const card = document.createElement('div');
      card.className = 'hl-card';
      const bg = colorHex[h.color] || '#ffd60a';
      card.innerHTML = `
        <div class="hl-card-text" style="background:${bg}">${sanitize(truncate(h.text, 160))}</div>
        ${h.note ? `<div class="hl-card-note">"${sanitize(h.note)}"</div>` : ''}
        <div class="hl-card-source">${sanitize(truncate(h.url, 60))}</div>
        <div class="hl-card-meta">${Storage.formatDate(h.createdAt)}</div>
        <div class="hl-card-actions">
          <button class="card-btn accent" data-url="${sanitize(h.url)}">🔗 Open Page</button>
          <button class="card-btn danger" data-url="${sanitize(h.url)}" data-id="${sanitize(h.id)}">🗑 Delete</button>
        </div>
      `;

      card.querySelector('[data-url].accent').addEventListener('click', () => chrome.tabs.create({ url: h.url }));
      card.querySelector('.danger').addEventListener('click', async () => {
        if (!confirm('Delete this highlight?')) return;
        await Storage.deleteHighlight(h.url, h.id);
        await loadData();
      });

      list.appendChild(card);
    });
  }

  // ── Edit Modal ─────────────────────────────────────────────
  function openEditModal(url) {
    editingUrl = url;
    const note = allNotes[url];
    document.getElementById('modalUrl').textContent = url;
    document.getElementById('modalTextarea').value = note?.note || '';
    document.getElementById('editModal').style.display = 'flex';
    document.getElementById('modalTextarea').focus();
  }

  function closeModal() {
    document.getElementById('editModal').style.display = 'none';
    editingUrl = null;
  }

  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('editModal').addEventListener('click', e => {
    if (e.target === document.getElementById('editModal')) closeModal();
  });

  document.getElementById('modalSave').addEventListener('click', async () => {
    const text = document.getElementById('modalTextarea').value.trim();
    if (!text) return;
    const note = allNotes[editingUrl];
    await Storage.saveNote(editingUrl, note?.title || '', text);
    closeModal();
    await loadData();
    showToast('Note updated ✓');
  });

  // ── Search ─────────────────────────────────────────────────
  document.getElementById('searchInput').addEventListener('input', e => {
    searchTerm = e.target.value.trim();
    render();
  });

  // ── Tabs ───────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.dataset.tab;
      document.getElementById('notesTab').style.display = activeTab === 'notes' ? 'block' : 'none';
      document.getElementById('highlightsTab').style.display = activeTab === 'highlights' ? 'block' : 'none';
      render();
    });
  });

  // ── Settings ───────────────────────────────────────────────
  document.getElementById('settingsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // ── Utils ──────────────────────────────────────────────────
  function sanitize(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function truncate(str, n) {
    return (str || '').length > n ? str.slice(0, n) + '…' : str || '';
  }

  function showToast(msg) {
    const t = document.createElement('div');
    Object.assign(t.style, {
      position: 'fixed', bottom: '24px', right: '24px',
      background: '#1a1918', color: 'white', padding: '10px 20px',
      borderRadius: '20px', fontSize: '13px', fontFamily: 'DM Sans, sans-serif',
      opacity: '0', transition: 'opacity 0.2s ease', zIndex: '9999'
    });
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.style.opacity = '1');
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2000);
  }

  // ── Init ───────────────────────────────────────────────────
  await loadData();
})();
