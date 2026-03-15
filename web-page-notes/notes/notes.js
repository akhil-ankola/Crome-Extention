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

  // ── Utils ──────────────────────────────────────────────────
  function sanitize(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function truncate(str, n) {
    return (str || '').length > n ? str.slice(0, n) + '…' : str || '';
  }

  function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function readJSONFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try { resolve(JSON.parse(e.target.result)); }
        catch { reject(new Error('Invalid JSON file. Please select a valid export file.')); }
      };
      reader.onerror = () => reject(new Error('Failed to read file.'));
      reader.readAsText(file);
    });
  }

  function showStatus(msg, type = 'success') {
    const el = document.getElementById('backupStatus');
    el.textContent = msg;
    el.className = `backup-status ${type}`;
    el.style.display = 'block';
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.style.display = 'none'; }, 5000);
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function showToast(msg) {
    const t = document.createElement('div');
    Object.assign(t.style, {
      position: 'fixed', bottom: '24px', right: '24px',
      background: '#1a1918', color: 'white', padding: '10px 20px',
      borderRadius: '20px', fontSize: '13px', fontFamily: 'Inter, sans-serif',
      opacity: '0', transition: 'opacity 0.2s ease', zIndex: '9999', pointerEvents: 'none'
    });
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.style.opacity = '1');
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2500);
  }

  // ── Validate import structure ──────────────────────────────
  function validateImportData(data) {
    if (typeof data !== 'object' || data === null) return false;
    return !!(data.notes || data.highlights);
  }

  function countImportStats(data) {
    const notes = data.notes || {};
    const highlights = data.highlights || {};
    const noteCount = Object.keys(notes).length;
    let hlCount = 0;
    Object.values(highlights).forEach(arr => hlCount += (Array.isArray(arr) ? arr.length : 0));
    const pages = new Set([...Object.keys(notes), ...Object.keys(highlights)]).size;
    return { noteCount, hlCount, pages };
  }

  // ── Merge / Replace dialog ─────────────────────────────────
  function showMergeDialog(stats, onMerge, onReplace) {
    const overlay = document.createElement('div');
    overlay.className = 'merge-dialog-overlay';
    overlay.innerHTML = `
      <div class="merge-dialog">
        <div class="merge-dialog-title">📥 Import Options</div>
        <div class="merge-dialog-sub">Choose how to handle the imported data:</div>
        <div class="merge-dialog-stats">
          Found in file:<br>
          <strong>${stats.noteCount}</strong> page note${stats.noteCount !== 1 ? 's' : ''}
          &nbsp;·&nbsp; <strong>${stats.hlCount}</strong> highlight${stats.hlCount !== 1 ? 's' : ''}
          &nbsp;·&nbsp; across <strong>${stats.pages}</strong> page${stats.pages !== 1 ? 's' : ''}
        </div>
        <div class="merge-dialog-actions">
          <button class="merge-btn cancel-m">Cancel</button>
          <button class="merge-btn replace">Replace</button>
          <button class="merge-btn merge">Merge</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('.cancel-m').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.replace').addEventListener('click', () => { overlay.remove(); onReplace(); });
    overlay.querySelector('.merge').addEventListener('click', () => { overlay.remove(); onMerge(); });
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  // ── Load Data ──────────────────────────────────────────────
  async function loadData() {
    allNotes = await Storage.getNotes();
    allHighlights = await Storage.getHighlights();
    updateStats();
    render();
    populatePageSelect();
    updateBackupStats();
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

  function updateBackupStats() {
    const noteCount = Object.keys(allNotes).length;
    let hlCount = 0;
    Object.values(allHighlights).forEach(arr => hlCount += arr.length);
    const pages = new Set([...Object.keys(allNotes), ...Object.keys(allHighlights)]).size;
    document.getElementById('bstatNotes').textContent = noteCount;
    document.getElementById('bstatHl').textContent = hlCount;
    document.getElementById('bstatPages').textContent = pages;
  }

  function populatePageSelect() {
    const select = document.getElementById('pageExportSelect');
    const allUrls = new Set([...Object.keys(allNotes), ...Object.keys(allHighlights)]);
    const current = select.value;
    select.innerHTML = '<option value="">— choose a page —</option>';
    [...allUrls].sort().forEach(url => {
      const opt = document.createElement('option');
      opt.value = url;
      const title = allNotes[url]?.title || '';
      opt.textContent = title
        ? `${truncate(title, 30)} — ${truncate(url, 40)}`
        : truncate(url, 65);
      if (url === current) opt.selected = true;
      select.appendChild(opt);
    });
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
          <button class="card-btn" data-action="export-page" data-url="${sanitize(url)}" title="Export this page">📤</button>
          <button class="card-btn danger" data-action="delete" data-url="${sanitize(url)}">🗑</button>
        </div>
      `;
      list.appendChild(card);
    });

    list.querySelectorAll('.card-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const url = btn.dataset.url;
        const action = btn.dataset.action;
        if (action === 'open') chrome.tabs.create({ url });
        if (action === 'edit') openEditModal(url);
        if (action === 'export-page') exportPageNotes(url);
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

  // ═══════════════════════════════════════════════════════════
  // ── FEATURE 1: Per-Page Export / Import (Share)  ──────────
  // ═══════════════════════════════════════════════════════════

  function buildPageExportPayload(url) {
    const note = allNotes[url] || null;
    const highlights = (allHighlights[url] || []).map(h => ({
      id: h.id,
      text: h.text,
      color: h.color || 'yellow',
      note: h.note || '',
      createdAt: h.createdAt
    }));
    return {
      _version: '1.0',
      _type: 'page-notes-export',
      _exportedAt: new Date().toISOString(),
      notes: note ? {
        [url]: {
          title: note.title || '',
          note: note.note || '',
          createdAt: note.createdAt,
          updatedAt: note.updatedAt
        }
      } : {},
      highlights: highlights.length > 0 ? { [url]: highlights } : {}
    };
  }

  function exportPageNotes(url) {
    if (!url) { showStatus('⚠ Please select a page from the dropdown first.', 'error'); return; }
    const note = allNotes[url];
    const highlights = allHighlights[url] || [];
    if (!note && highlights.length === 0) {
      showStatus('⚠ No notes or highlights found for this page.', 'error');
      return;
    }
    const payload = buildPageExportPayload(url);
    const slug = url.replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').slice(0, 40);
    downloadJSON(payload, `page-notes-${slug}.json`);
    showStatus(
      `✓ Exported: ${note ? 1 : 0} note + ${highlights.length} highlight(s) for this page.`,
      'success'
    );
  }

  document.getElementById('exportPageBtn').addEventListener('click', () => {
    exportPageNotes(document.getElementById('pageExportSelect').value);
  });

  document.getElementById('importPageBtn').addEventListener('click', () => {
    document.getElementById('importPageFile').click();
  });

  document.getElementById('importPageFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    let data;
    try { data = await readJSONFile(file); }
    catch (err) { showStatus('✕ ' + err.message, 'error'); return; }

    if (!validateImportData(data)) {
      showStatus('✕ Unrecognised file format. Use a file exported from Web Page Notes.', 'error');
      return;
    }

    const stats = countImportStats(data);
    if (stats.noteCount === 0 && stats.hlCount === 0) {
      showStatus('⚠ This file contains no notes or highlights.', 'info');
      return;
    }

    showMergeDialog(
      stats,
      async () => {
        // Merge: add imported, keep existing on conflict
        await mergeImport(data);
        showStatus(`✓ Merged ${stats.noteCount} note(s) and ${stats.hlCount} highlight(s).`, 'success');
        showToast('Import complete ✓');
        await loadData();
      },
      async () => {
        // Replace only the pages present in the file
        await replacePageImport(data);
        showStatus(`✓ Replaced notes for ${stats.pages} page(s).`, 'success');
        showToast('Import complete ✓');
        await loadData();
      }
    );
  });

  // ═══════════════════════════════════════════════════════════
  // ── FEATURE 2: Full Backup / Restore ──────────────────────
  // ═══════════════════════════════════════════════════════════

  document.getElementById('exportAllBtn').addEventListener('click', async () => {
    const noteCount = Object.keys(allNotes).length;
    const hlCount = Object.values(allHighlights).reduce((a, arr) => a + arr.length, 0);

    if (noteCount === 0 && hlCount === 0) {
      showStatus('⚠ Nothing to export — add some notes first.', 'info');
      return;
    }

    const pages = new Set([...Object.keys(allNotes), ...Object.keys(allHighlights)]).size;
    const payload = {
      _version: '1.0',
      _type: 'page-notes-full-backup',
      _exportedAt: new Date().toISOString(),
      _stats: { notes: noteCount, highlights: hlCount, pages },
      notes: allNotes,
      highlights: allHighlights
    };

    const date = new Date().toISOString().slice(0, 10);
    downloadJSON(payload, `all-page-notes-backup-${date}.json`);
    showStatus(
      `✓ Full backup downloaded: ${noteCount} note(s), ${hlCount} highlight(s), ${pages} page(s).`,
      'success'
    );
  });

  document.getElementById('importAllBtn').addEventListener('click', () => {
    document.getElementById('importAllFile').click();
  });

  document.getElementById('importAllFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    let data;
    try { data = await readJSONFile(file); }
    catch (err) { showStatus('✕ ' + err.message, 'error'); return; }

    if (!validateImportData(data)) {
      showStatus('✕ Unrecognised file. Please use a valid backup file.', 'error');
      return;
    }

    const stats = countImportStats(data);
    if (stats.noteCount === 0 && stats.hlCount === 0) {
      showStatus('⚠ The backup file is empty.', 'info');
      return;
    }

    showMergeDialog(
      stats,
      async () => {
        await mergeImport(data);
        showStatus(
          `✓ Merged backup: ${stats.noteCount} note(s) and ${stats.hlCount} highlight(s).`,
          'success'
        );
        showToast('Backup restored ✓');
        await loadData();
      },
      async () => {
        if (!confirm(
          '⚠ REPLACE ALL DATA\n\nThis will permanently delete all your current notes and highlights, then restore from the backup.\n\nThis cannot be undone. Continue?'
        )) return;
        await fullReplaceImport(data);
        showStatus(
          `✓ All data replaced from backup: ${stats.noteCount} note(s), ${stats.hlCount} highlight(s).`,
          'success'
        );
        showToast('Backup restored ✓');
        await loadData();
      }
    );
  });

  // ── Storage merge helpers ──────────────────────────────────

  // Merge: keep newer notes, de-duplicate highlights by id
  async function mergeImport(data) {
    const existingNotes = await Storage.getNotes();
    const existingHl = await Storage.getHighlights();

    const mergedNotes = { ...existingNotes };
    for (const [url, note] of Object.entries(data.notes || {})) {
      if (!mergedNotes[url]) {
        mergedNotes[url] = note;
      } else {
        const existingUpdated = mergedNotes[url].updatedAt || '';
        const importedUpdated = note.updatedAt || '';
        if (importedUpdated > existingUpdated) mergedNotes[url] = note;
      }
    }

    const mergedHl = { ...existingHl };
    for (const [url, hls] of Object.entries(data.highlights || {})) {
      if (!Array.isArray(hls)) continue;
      if (!mergedHl[url]) {
        mergedHl[url] = hls;
      } else {
        const existingIds = new Set(mergedHl[url].map(h => h.id));
        const newOnes = hls.filter(h => !existingIds.has(h.id));
        mergedHl[url] = [...mergedHl[url], ...newOnes];
      }
    }

    return new Promise(resolve =>
      chrome.storage.local.set({ notes: mergedNotes, highlights: mergedHl }, resolve)
    );
  }

  // Replace only URLs from the imported file, leave others intact
  async function replacePageImport(data) {
    const existingNotes = await Storage.getNotes();
    const existingHl = await Storage.getHighlights();

    for (const [url, note] of Object.entries(data.notes || {})) {
      existingNotes[url] = note;
    }
    for (const [url, hls] of Object.entries(data.highlights || {})) {
      if (Array.isArray(hls)) existingHl[url] = hls;
    }

    return new Promise(resolve =>
      chrome.storage.local.set({ notes: existingNotes, highlights: existingHl }, resolve)
    );
  }

  // Wipe everything and restore from backup
  async function fullReplaceImport(data) {
    const toSet = {};
    if (data.notes) toSet.notes = data.notes;
    if (data.highlights) toSet.highlights = data.highlights;
    // Clear first, then set
    return new Promise(resolve =>
      chrome.storage.local.remove(['notes', 'highlights'], () =>
        chrome.storage.local.set(toSet, resolve)
      )
    );
  }

  // ── Init ───────────────────────────────────────────────────
  await loadData();
})();
