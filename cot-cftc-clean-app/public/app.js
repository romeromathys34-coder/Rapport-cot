const state = { reports: [], selected: null, query: '' };

const els = {
  syncBtn: document.getElementById('syncBtn'),
  reportMeta: document.getElementById('reportMeta'),
  message: document.getElementById('message'),
  assetCount: document.getElementById('assetCount'),
  searchInput: document.getElementById('searchInput'),
  clearSearchBtn: document.getElementById('clearSearchBtn'),
  searchStatus: document.getElementById('searchStatus'),
  tickerTrack: document.getElementById('tickerTrack'),
  assetSections: document.getElementById('assetSections')
};

els.syncBtn.addEventListener('click', syncCFTC);
els.searchInput.addEventListener('input', () => {
  state.query = normalizeSearch(els.searchInput.value);
  renderAssets();
});
els.clearSearchBtn.addEventListener('click', () => {
  els.searchInput.value = '';
  state.query = '';
  renderAssets();
  els.searchInput.focus();
});

loadReports();
setInterval(loadReports, 15 * 60 * 1000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js').catch(() => {});
}

async function loadReports() {
  try {
    const data = await fetchReportsWithFallback();
    state.reports = data.reports || [];
    state.selected = state.reports[0] || null;
    hideMessage();
    render();
  } catch (error) {
    showMessage(`Impossible de charger les données CFTC : ${error.message}`, 'err');
  }
}

async function fetchReportsWithFallback() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const response = await fetch('/api/reports', { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error('API indisponible');
    return await response.json();
  } catch (error) {
    if (Array.isArray(window.COT_REPORTS)) {
      return { reports: window.COT_REPORTS };
    }
    const response = await fetch('/data/reports.json');
    if (!response.ok) throw error;
    const reports = await response.json();
    return { reports: Array.isArray(reports) ? reports : [] };
  }
}

async function syncCFTC() {
  if (location.protocol === 'file:') {
    showMessage('La synchronisation fonctionne sur le site publié. En fichier local, la recherche utilise les données sauvegardées.', 'err');
    return;
  }

  els.syncBtn.disabled = true;
  els.syncBtn.textContent = 'Synchronisation...';
  showMessage('Connexion à la CFTC en cours...', 'ok');

  try {
    const response = await fetch('/api/sync', { method: 'POST' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Synchronisation impossible');

    state.reports = data.reports || [];
    state.selected = data.report || state.reports[0] || null;
    hideMessage();
    render();
    showMessage('Rapport CFTC synchronisé.', 'ok');
  } catch (error) {
    showMessage(error.message, 'err');
  } finally {
    els.syncBtn.disabled = false;
    els.syncBtn.textContent = 'Synchroniser';
  }
}

function render() {
  const report = state.selected;
  if (!report) {
    els.reportMeta.textContent = 'Aucun rapport chargé';
    els.assetCount.textContent = '0 actif indexé';
    els.searchStatus.textContent = 'Clique sur Synchroniser';
    els.tickerTrack.innerHTML = '';
    els.assetSections.innerHTML = emptyHtml('Aucune donnée', 'Synchronise le site pour charger le dernier rapport CFTC.');
    return;
  }

  els.reportMeta.textContent = report.reportDate || report.reportDateRaw || 'Rapport CFTC';
  els.assetCount.textContent = `${format(report.assets.length)} lignes CFTC`;
  renderTicker(report.assets || []);
  renderAssets();
}

function renderAssets() {
  const report = state.selected;
  if (!report) return;

  els.clearSearchBtn.classList.toggle('hidden', !state.query);

  if (!state.query) {
    els.searchStatus.textContent = 'Tape un actif pour voir les données';
    els.assetSections.innerHTML = emptyHtml('Prêt à chercher', 'Exemples : Gold, Silver, Bitcoin, Euro FX, Corn, Natural Gas.');
    return;
  }

  const queryTerms = expandQuery(state.query);
  const rawAssets = sortMatches(filterAssets(report.assets || [], queryTerms), queryTerms);
  const assets = bestAssetPerMarket(rawAssets);

  els.searchStatus.textContent = assets.length
    ? `Résultat pour "${escapeHtml(els.searchInput.value)}"`
    : `Aucun résultat pour "${escapeHtml(els.searchInput.value)}"`;

  els.assetSections.innerHTML = assets.length
    ? `<section class="results-grid">${assets.map(cardHtml).join('')}</section>`
    : emptyHtml('Aucun actif trouvé', 'Essaie le nom anglais CFTC : Gold, Euro FX, Natural Gas, Australian Dollar, Corn.');
}

function renderTicker(assets) {
  const tickerAssets = buildTickerAssets(assets);
  const groupHtml = tickerAssets.map(tickerItemHtml).join('');
  els.tickerTrack.innerHTML = `
    <div class="ticker-group">${groupHtml}</div>
    <div class="ticker-group" aria-hidden="true">${groupHtml}</div>
  `;
}

function tickerItemHtml(asset) {
  const tone = asset.score > 0 ? 'up' : asset.score < 0 ? 'down' : 'flat';
  const arrow = asset.score > 0 ? '↑' : asset.score < 0 ? '↓' : '→';
  return `<span class="ticker-item ${tone}">
    <span>${escapeHtml(asset.name)}</span>
    <strong>${arrow}</strong>
  </span>`;
}

function filterAssets(assets, queryTerms) {
  const exact = assets.filter(asset => queryTerms.some(term => normalizeSearch(asset.name) === term));
  if (exact.length) return exact;

  const startsWith = assets.filter(asset => queryTerms.some(term => normalizeSearch(asset.name).startsWith(term)));
  if (startsWith.length) return startsWith;

  return assets.filter(asset => {
    const text = searchableText(asset);
    return queryTerms.some(term => text.includes(term));
  });
}

function sortMatches(assets, queryTerms) {
  return [...assets].sort((a, b) => {
    const aRank = rankMatch(normalizeSearch(a.name), queryTerms);
    const bRank = rankMatch(normalizeSearch(b.name), queryTerms);
    if (aRank !== bRank) return aRank - bRank;
    return a.name.localeCompare(b.name);
  });
}

function bestAssetPerMarket(assets) {
  const grouped = new Map();
  for (const asset of assets) {
    const key = normalizeSearch(asset.name || asset.marketName || '');
    const current = grouped.get(key);
    if (!current || reportPriority(asset) < reportPriority(current)) grouped.set(key, asset);
  }
  return Array.from(grouped.values())
    .sort((a, b) => reportPriority(a) - reportPriority(b) || a.name.localeCompare(b.name))
    .slice(0, 1);
}

function buildTickerAssets(assets) {
  const grouped = new Map();
  for (const asset of assets) {
    const key = normalizeSearch(asset.name || asset.marketName || '');
    const current = grouped.get(key);
    if (!current || reportPriority(asset) < reportPriority(current)) grouped.set(key, asset);
  }
  return Array.from(grouped.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function reportPriority(asset) {
  if (asset.reportFamily === 'Current Disaggregated Reports' && ['Metaux', 'Energie', 'Agriculture'].includes(asset.category)) return 0;
  if (asset.reportFamily === 'Current Traders in Financial Futures Reports' && ['Devises', 'Taux', 'Indices', 'Cryptomonnaies'].includes(asset.category)) return 0;
  if (asset.reportFamily === 'Current Disaggregated Reports') return 1;
  if (asset.reportFamily === 'Current Traders in Financial Futures Reports') return 2;
  return 3;
}

function rankMatch(name, queryTerms) {
  if (queryTerms.some(term => name === term)) return 0;
  if (queryTerms.some(term => name.startsWith(term))) return 1;
  return 2;
}

function searchableText(asset) {
  return normalizeSearch([
    asset.name,
    asset.symbol,
    asset.category,
    asset.bias,
    asset.marketName,
    asset.sourceLabel
  ].join(' '));
}

function cardHtml(asset) {
  const tone = asset.score > 0 ? 'green' : asset.score < 0 ? 'red' : 'gray';
  return `<article class="result-card ${tone}">
    <div class="card-head">
      <div>
        <h2>${escapeHtml(asset.name)}</h2>
        <p>${escapeHtml(asset.marketName)}</p>
      </div>
      <span class="badge ${tone}">${asset.score > 0 ? 'Haussier' : asset.score < 0 ? 'Baissier' : 'Neutre'}</span>
    </div>
    <div class="metrics">
      ${metricHtml('Position nette', `${format(asset.netPosition)} contrats`)}
      ${metricHtml('Variation hebdo', asset.weeklyChange || 'Premier rapport stocké')}
      ${metricHtml(`Longs ${asset.groupUsed}`, format(asset.longPositions))}
      ${metricHtml(`Shorts ${asset.groupUsed}`, format(asset.shortPositions))}
      ${metricHtml(`Spreads ${asset.groupUsed}`, format(asset.spreadPositions))}
      ${metricHtml('Open Interest', format(asset.openInterest))}
    </div>
    <div class="details">
      <span><strong>Biais</strong>${escapeHtml(asset.bias)}</span>
      <span><strong>Groupe</strong>${escapeHtml(asset.groupUsed)}</span>
      <span><strong>Rapport</strong>${escapeHtml(asset.reportType)}</span>
      <span><strong>Date</strong>${escapeHtml(asset.reportDate || 'Non disponible')}</span>
      <a href="${escapeAttr(asset.sourcePage)}" target="_blank" rel="noreferrer">Page CFTC</a>
    </div>
  </article>`;
}

function metricHtml(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function emptyHtml(title, text) {
  return `<section class="empty-state">
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(text)}</span>
  </section>`;
}

function showMessage(text, type) {
  els.message.textContent = text;
  els.message.className = `message ${type}`;
  els.message.classList.remove('hidden');
}

function hideMessage() {
  els.message.classList.add('hidden');
}

function format(value) {
  return new Intl.NumberFormat('fr-FR').format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function normalizeSearch(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function expandQuery(query) {
  const aliases = {
    or: ['gold'],
    argent: ['silver'],
    petrole: ['wti', 'crude', 'crude oil'],
    petrol: ['wti', 'crude', 'crude oil'],
    gaz: ['natural gas', 'gas'],
    ble: ['wheat'],
    mais: ['corn'],
    soja: ['soybean', 'soybeans'],
    euro: ['euro fx', 'euro'],
    livre: ['british pound', 'pound'],
    yen: ['japanese yen', 'yen'],
    nasdaq: ['nasdaq'],
    sp500: ['s&p 500', 'sp 500'],
    's&p500': ['s&p 500', 'sp 500'],
    bitcoin: ['bitcoin'],
    btc: ['bitcoin', 'btc'],
    ethereum: ['ether', 'ethereum', 'eth'],
    eth: ['ether', 'ethereum', 'eth']
  };
  return [query, ...(aliases[query] || []).map(normalizeSearch)].filter(Boolean);
}
