// options/options.js
(async () => {
  // ── Load settings ──────────────────────────────────────────
  const settings = await Storage.getSettings();

  // Apply theme
  if (settings.theme === 'dark') document.body.classList.add('dark');

  // Set radio values
  const themeRadio = document.querySelector(`input[name="theme"][value="${settings.theme || 'light'}"]`);
  if (themeRadio) themeRadio.checked = true;

  const indicatorRadio = document.querySelector(`input[name="indicator"][value="${settings.indicator || 'badge'}"]`);
  if (indicatorRadio) indicatorRadio.checked = true;

  // ── Nav ────────────────────────────────────────────────────
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
      document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
      link.classList.add('active');
      document.getElementById(`section-${link.dataset.section}`).classList.add('active');
    });
  });

  // ── Theme live preview ─────────────────────────────────────
  document.querySelectorAll('input[name="theme"]').forEach(radio => {
    radio.addEventListener('change', () => {
      document.body.classList.toggle('dark', radio.value === 'dark');
    });
  });

  // ── Save ───────────────────────────────────────────────────
  document.getElementById('saveBtn').addEventListener('click', async () => {
    const theme = document.querySelector('input[name="theme"]:checked')?.value || 'light';
    const indicator = document.querySelector('input[name="indicator"]:checked')?.value || 'badge';
    await Storage.saveSettings({ theme, indicator });
    showStatus('Settings saved ✓');
  });

  function showStatus(msg) {
    const el = document.getElementById('saveStatus');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2500);
  }

  // ── Export ─────────────────────────────────────────────────
  document.getElementById('exportBtn').addEventListener('click', async () => {
    const data = await Storage.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `page-notes-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── Import ─────────────────────────────────────────────────
  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });

  document.getElementById('importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.notes && !data.highlights) {
        alert('Invalid file format. Please export from Web Page Notes first.');
        return;
      }
      if (!confirm(`Import ${Object.keys(data.notes || {}).length} notes and highlights? This will merge with existing data.`)) return;
      
      // Merge (don't overwrite)
      const existing = await Storage.exportAll();
      const merged = {
        notes: { ...(existing.notes || {}), ...(data.notes || {}) },
        highlights: { ...(existing.highlights || {}), ...(data.highlights || {}) }
      };
      
      // For highlights, merge arrays
      for (const url of Object.keys(data.highlights || {})) {
        if (existing.highlights && existing.highlights[url]) {
          const existingIds = new Set(existing.highlights[url].map(h => h.id));
          const newHls = data.highlights[url].filter(h => !existingIds.has(h.id));
          merged.highlights[url] = [...existing.highlights[url], ...newHls];
        }
      }
      
      await Storage.importAll(merged);
      showStatus(`Imported successfully ✓`);
    } catch (err) {
      alert('Failed to parse file: ' + err.message);
    }
    e.target.value = '';
  });

  // ── Delete All ─────────────────────────────────────────────
  document.getElementById('deleteAllBtn').addEventListener('click', async () => {
    if (!confirm('⚠️ Delete ALL notes and highlights? This cannot be undone!')) return;
    if (!confirm('Are you absolutely sure?')) return;
    await Storage.deleteAll();
    showStatus('All data deleted');
    updateStorageInfo();
  });

  // ── Storage Info ───────────────────────────────────────────
  async function updateStorageInfo() {
    const data = await Storage.exportAll();
    const str = JSON.stringify(data);
    const bytes = new TextEncoder().encode(str).length;
    const kb = (bytes / 1024).toFixed(1);
    const maxKb = 5120; // 5MB chrome.storage.local default
    const pct = Math.min((bytes / (maxKb * 1024)) * 100, 100);

    document.getElementById('siFill').style.width = pct + '%';
    document.getElementById('siText').textContent = `${kb} KB / 5 MB`;
  }

  updateStorageInfo();
})();
