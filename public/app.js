const state = { reports: [], selected: null, query: '' };
const staticSite = location.protocol === 'file:' || location.hostname.endsWith('github.io');
let messageTimer = null;

const els = {
  reportMeta: document.getElementById('reportMeta'),
  message: document.getElementById('message'),
  searchInput: document.getElementById('searchInput'),
  clearSearchBtn: document.getElementById('clearSearchBtn'),
  hero: document.querySelector('.hero'),
  tickerTrack: document.getElementById('tickerTrack'),
  assetSections: document.getElementById('assetSections')
};

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
window.addEventListener('pointermove', event => {
  if (!els.hero) return;
  els.hero.style.setProperty('--pointer-x', `${Math.round((event.clientX / window.innerWidth) * 100)}%`);
  els.hero.style.setProperty('--pointer-y', `${Math.round((event.clientY / window.innerHeight) * 100)}%`);
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

function render() {
  const report = state.selected;
  if (!report) {
    els.reportMeta.textContent = 'Aucun rapport';
    els.tickerTrack.innerHTML = '';
    els.assetSections.innerHTML = '';
    return;
  }

  els.reportMeta.textContent = formatReportMeta(report);
  renderTicker(report.assets || []);
  renderAssets();
}

function renderAssets() {
  const report = state.selected;
  if (!report) return;

  els.clearSearchBtn.classList.toggle('hidden', !state.query);

  if (!state.query) {
    document.body.classList.remove('is-searching');
    els.assetSections.innerHTML = '';
    return;
  }
  document.body.classList.add('is-searching');

  const queryTerms = expandQuery(state.query);
  const rawAssets = sortMatches(filterAssets(report.assets || [], queryTerms), queryTerms);
  const assets = bestAssetPerMarket(rawAssets);

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
  return interleaveTickerAssets(Array.from(grouped.values()));
}

function interleaveTickerAssets(assets) {
  const buckets = new Map();
  for (const asset of assets) {
    const key = `${asset.category || 'Autres'}-${asset.score > 0 ? 'up' : asset.score < 0 ? 'down' : 'flat'}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(asset);
  }

  const groups = Array.from(buckets.values()).map(group => group.sort((a, b) => a.name.localeCompare(b.name)));
  const mixed = [];
  while (groups.some(group => group.length)) {
    for (const group of groups) {
      const next = group.shift();
      if (next) mixed.push(next);
    }
  }
  return mixed;
}

function reportPriority(asset) {
  if (['Cryptomonnaies', 'Indices'].includes(asset.category) && asset.reportFamily === 'Current Legacy Reports') return 0;
  if (['Metaux', 'Energie'].includes(asset.category) && asset.reportFamily === 'Current Disaggregated Reports') return 0;
  if (asset.reportFamily === 'Current Legacy Reports') return 1;
  if (asset.reportFamily === 'Current Disaggregated Reports') return 2;
  if (asset.reportFamily === 'Current Traders in Financial Futures Reports') return 3;
  return 4;
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
  clearTimeout(messageTimer);
  els.message.textContent = text;
  els.message.className = `message ${type}`;
  els.message.classList.remove('hidden');
  requestAnimationFrame(() => els.message.classList.add('visible'));
  messageTimer = setTimeout(() => hideMessage(), type === 'ok' ? 2200 : 5200);
}

function hideMessage() {
  els.message.classList.remove('visible');
  setTimeout(() => {
    if (!els.message.classList.contains('visible')) els.message.classList.add('hidden');
  }, 650);
}

function format(value) {
  return new Intl.NumberFormat('fr-FR').format(Number(value || 0));
}

function formatReportMeta(report) {
  const raw = report.reportDateRaw || report.reportDate;
  if (!raw) return 'Rapport CFTC';
  const rawText = String(raw).trim();
  const isoDate = rawText.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDate) {
    const date = new Date(Date.UTC(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3])));
    return `Rapport du ${date.toLocaleDateString('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })}`;
  }
  if (/^\d{1,2}\s+\S+\s+\d{4}$/i.test(rawText)) return `Rapport du ${rawText}`;
  const date = new Date(rawText);
  if (Number.isNaN(date.getTime())) return rawText.split('T')[0] || 'Rapport CFTC';
  return `Rapport du ${date.toLocaleDateString('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })}`;
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
