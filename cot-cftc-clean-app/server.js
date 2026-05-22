const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4000;
const DATA_DIR = path.join(__dirname, 'data');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_REPORTS_FILE = path.join(PUBLIC_DIR, 'reports-static.js');
const AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000;

const DATASETS = [
  {
    key: 'legacy',
    label: 'Legacy Futures Only',
    reportFamily: 'Current Legacy Reports',
    reportType: 'Futures Only / Non-Commercial',
    groupUsed: 'Non-Commercial',
    formula: 'Position nette = Non-Commercial Long - Non-Commercial Short',
    url: 'https://www.cftc.gov/dea/newcot/deafut.txt',
    parser: parseLegacyRow
  },
  {
    key: 'disaggregated',
    label: 'Disaggregated Futures Only',
    reportFamily: 'Current Disaggregated Reports',
    reportType: 'Futures Only / Managed Money',
    groupUsed: 'Managed Money',
    formula: 'Position nette = Managed Money Long - Managed Money Short',
    url: 'https://www.cftc.gov/dea/newcot/f_disagg.txt',
    parser: parseDisaggregatedRow
  },
  {
    key: 'financial',
    label: 'Traders in Financial Futures',
    reportFamily: 'Current Traders in Financial Futures Reports',
    reportType: 'Futures Only / Leveraged Funds',
    groupUsed: 'Leveraged Funds',
    formula: 'Position nette = Leveraged Funds Long - Leveraged Funds Short',
    url: 'https://www.cftc.gov/dea/newcot/FinFutWk.txt',
    parser: parseFinancialRow
  }
];

ensureDataFile();
let syncInProgress = false;
let lastAutoSyncAttemptAt = null;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/reports' && req.method === 'GET') {
      const reports = readReports();
      return sendJson(res, 200, { reports, nextRelease: getNextReleaseInfo(reports) });
    }

    if (url.pathname === '/api/health' && req.method === 'GET') {
      const reports = readReports();
      return sendJson(res, 200, {
        ok: true,
        latestReport: reports[0] ? reports[0].label : null,
        assets: reports[0] && reports[0].assets ? reports[0].assets.length : 0,
        checkedAt: new Date().toISOString()
      });
    }

    if (url.pathname === '/api/sync' && req.method === 'POST') {
      const result = await syncLatestReport({ force: true, reason: 'manual' });
      return sendJson(res, 200, { ok: true, ...result, nextRelease: getNextReleaseInfo(result.reports) });
    }

    if (url.pathname === '/data/reports.json' && req.method === 'GET') {
      return sendJson(res, 200, readReports());
    }

    if (url.pathname === '/api/source' && req.method === 'GET') {
      return sendJson(res, 200, {
        source: 'CFTC officielle',
        datasets: DATASETS.map(({ key, label, url, reportFamily, reportType }) => ({ key, label, url, reportFamily, reportType }))
      });
    }

    serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { ok: false, error: error.message || String(error) });
  }
});

server.listen(PORT, () => {
  console.log(`COT Market Search lance : http://localhost:${PORT}`);
  console.log('Source : fichiers officiels CFTC Legacy, Disaggregated et Financial Futures.');
  console.log('Synchronisation automatique active : verification au demarrage puis toutes les 15 minutes.');
  setTimeout(() => autoSyncIfDue('startup'), 5000);
});

setInterval(() => autoSyncIfDue('interval'), AUTO_SYNC_INTERVAL_MS);

async function autoSyncIfDue(reason) {
  try {
    const reports = readReports();
    if (!shouldAutoSync(reports)) return;
    const result = await syncLatestReport({ force: false, reason });
    if (result.saved) {
      console.log(`Nouveau rapport COT sauvegarde automatiquement : ${result.report.label} (${result.report.assets.length} lignes)`);
    } else {
      console.log(`Verification CFTC automatique : aucun nouveau rapport (${result.report.label}).`);
    }
  } catch (e) {
    console.error('Erreur synchronisation automatique CFTC:', e.message);
  }
}

function shouldAutoSync(reports) {
  if (syncInProgress) return false;
  if (lastAutoSyncAttemptAt && Date.now() - lastAutoSyncAttemptAt.getTime() < AUTO_SYNC_INTERVAL_MS - 1000) return false;
  if (!Array.isArray(reports) || !reports.length) return true;
  const nextRelease = getNextReleaseInfo(reports);
  return Date.now() >= new Date(nextRelease.iso).getTime();
}

async function syncLatestReport({ force, reason }) {
  if (syncInProgress) throw new Error('Synchronisation deja en cours.');
  syncInProgress = true;
  lastAutoSyncAttemptAt = new Date();

  try {
    const report = await generateReportFromCFTC();
    const reports = readReports();
    const alreadySaved = reports.some(r => r.id === report.id);

    if (!force && alreadySaved) {
      return { saved: false, report: reports.find(r => r.id === report.id) || report, reports, reason };
    }

    const updatedReports = reports.filter(r => r.id !== report.id);
    updatedReports.unshift(report);
    writeReports(updatedReports);
    return { saved: true, report, reports: updatedReports, reason };
  } finally {
    syncInProgress = false;
  }
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  if (!fs.existsSync(REPORTS_FILE)) fs.writeFileSync(REPORTS_FILE, '[]', 'utf8');
}

function readReports() {
  ensureDataFile();
  try { return JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8')); }
  catch { return []; }
}

function writeReports(reports) {
  ensureDataFile();
  fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2), 'utf8');
  fs.writeFileSync(STATIC_REPORTS_FILE, `window.COT_REPORTS = ${JSON.stringify(reports)};\n`, 'utf8');
}

async function generateReportFromCFTC() {
  const previous = readReports()[0];
  const assets = [];

  for (const dataset of DATASETS) {
    const response = await fetch(dataset.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 COT-Market-Search/1.0',
        Accept: 'text/plain,*/*'
      }
    });
    if (!response.ok) throw new Error(`CFTC inaccessible pour ${dataset.label} : HTTP ${response.status}`);

    const text = await response.text();
    for (const row of parseCsvRows(text)) {
      const asset = dataset.parser(row, dataset);
      if (!asset) continue;

      const prevAsset = previous && Array.isArray(previous.assets)
        ? previous.assets.find(a => a.id === asset.id)
        : null;
      if (prevAsset && asset.available) {
        const diff = asset.netPosition - Number(prevAsset.netPosition || 0);
        asset.weeklyChange = `${diff >= 0 ? '+' : ''}${formatNumber(diff)} contrats vs rapport precedent`;
      }
      assets.push(asset);
    }
  }

  const reportDateRaw = assets.find(a => a.reportDateRaw)?.reportDateRaw || new Date().toISOString().slice(0, 10);
  const id = `cot-all-current-${reportDateRaw}`.replace(/[^a-zA-Z0-9_-]/g, '-');

  return {
    id,
    label: `Rapport COT complet du ${formatDateFr(reportDateRaw)}`,
    reportDateRaw,
    generatedAt: new Date().toLocaleString('fr-FR'),
    source: 'CFTC officielle',
    reportFamily: 'Legacy + Disaggregated + Traders in Financial Futures',
    reportType: 'Futures Only',
    format: 'Comma Delimited',
    groupUsed: 'Selon la liste CFTC',
    formula: 'Voir chaque resultat actif',
    pagesUsed: Object.fromEntries(DATASETS.map(d => [d.key, { label: d.label, url: d.url }])),
    summary: `${assets.length} lignes CFTC indexees dans toutes les listes courantes principales.`,
    assets: assets.sort((a, b) => a.name.localeCompare(b.name) || a.reportFamily.localeCompare(b.reportFamily))
  };
}

function parseLegacyRow(row, dataset) {
  return assetFromRow(row, dataset, {
    openInterest: 7,
    long: 8,
    short: 9,
    spread: 10,
    categoryLabel: 'Non-Commercial'
  });
}

function parseDisaggregatedRow(row, dataset) {
  return assetFromRow(row, dataset, {
    openInterest: 7,
    long: 13,
    short: 14,
    spread: 15,
    categoryLabel: 'Managed Money'
  });
}

function parseFinancialRow(row, dataset) {
  return assetFromRow(row, dataset, {
    openInterest: 7,
    long: 14,
    short: 15,
    spread: 16,
    categoryLabel: 'Leveraged Funds'
  });
}

function assetFromRow(row, dataset, columns) {
  if (!row || row.length < 12 || !row[0]) return null;

  const marketName = clean(row[0]);
  const reportDateRaw = clean(row[2]);
  const marketCode = clean(row[3]);
  const exchangeCode = clean(row[4]);
  const openInterest = toNumber(row[columns.openInterest]);
  const longPositions = toNumber(row[columns.long]);
  const shortPositions = toNumber(row[columns.short]);
  const spreadPositions = toNumber(row[columns.spread]);
  const netPosition = longPositions - shortPositions;
  const score = scoreFromNet(netPosition, openInterest);
  const name = marketNameToLabel(marketName);

  return {
    id: `${dataset.key}:${marketCode}:${exchangeCode}:${marketName}`,
    name,
    symbol: marketCode || marketNameToSymbol(marketName),
    category: categoryForMarket(marketName),
    available: true,
    sourcePage: dataset.url,
    sourceLabel: dataset.label,
    marketName,
    market: marketName,
    marketCode,
    exchangeCode,
    reportDateRaw,
    reportDate: formatDateFr(reportDateRaw),
    reportFamily: dataset.reportFamily,
    reportType: dataset.reportType,
    format: 'Comma Delimited',
    groupUsed: columns.categoryLabel,
    formula: dataset.formula,
    openInterest,
    longPositions,
    shortPositions,
    spreadPositions,
    netPosition,
    weeklyChange: 'Premier rapport stocke',
    score,
    bias: biasLabel(score),
    explanation: explanation(name, score, columns.categoryLabel)
  };
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (c === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        value += c;
      }
      continue;
    }

    if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(value.trim());
      value = '';
    } else if (c === '\n') {
      row.push(value.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      value = '';
    } else if (c !== '\r') {
      value += c;
    }
  }

  if (value || row.length) {
    row.push(value.trim());
    if (row.some(Boolean)) rows.push(row);
  }
  return rows;
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function marketNameToLabel(market) {
  return clean(market).split(' - ')[0].trim() || clean(market);
}

function marketNameToSymbol(market) {
  return marketNameToLabel(market)
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join(' ')
    .toUpperCase();
}

function categoryForMarket(market) {
  const name = marketNameToLabel(market).toUpperCase();
  if (/GOLD|SILVER|COPPER|PLATINUM|PALLADIUM|ALUMIN/.test(name)) return 'Metaux';
  if (/CRUDE|WTI|BRENT|GAS|GASOLINE|HEATING OIL|PROPANE|ETHANOL|OIL|POWER|ELECTRIC/.test(name)) return 'Energie';
  if (/S&P|NASDAQ|DOW|NIKKEI|RUSSELL|VIX|STOCK|INDEX|BLOOMBERG/.test(name)) return 'Indices';
  if (/BITCOIN|ETHER|CRYPTO|COIN/.test(name)) return 'Cryptomonnaies';
  if (/EURO|YEN|FRANC|POUND|DOLLAR|PESO|REAL|RUBLE|RAND|KRONA|CURRENCY|FX/.test(name)) return 'Devises';
  if (/TREASURY|BOND|NOTE|RATE|FED FUNDS|EURODOLLAR|SOFR|INTEREST/.test(name)) return 'Taux';
  if (/CORN|WHEAT|SOY|OAT|RICE|CATTLE|HOG|MILK|COCOA|COFFEE|COTTON|SUGAR|LUMBER|JUICE|BUTTER|CHEESE/.test(name)) return 'Agriculture';
  return 'Autres';
}

function toNumber(v) {
  const text = String(v || '').replace(/,/g, '').trim();
  if (!text || text === '.') return 0;
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

function scoreFromNet(net, openInterest) {
  if (!openInterest) return 0;
  const ratio = net / openInterest;
  if (ratio > 0.12) return 2;
  if (ratio > 0.03) return 1;
  if (ratio < -0.12) return -2;
  if (ratio < -0.03) return -1;
  return 0;
}

function biasLabel(score) {
  if (score >= 2) return 'Haussier fort';
  if (score === 1) return 'Haussier';
  if (score === -1) return 'Baissier';
  if (score <= -2) return 'Baissier fort';
  return 'Neutre';
}

function explanation(name, score, groupUsed) {
  if (score > 0) return `Le groupe ${groupUsed} est davantage acheteur que vendeur sur ${name}.`;
  if (score < 0) return `Le groupe ${groupUsed} est davantage vendeur qu acheteur sur ${name}.`;
  return `Le positionnement du groupe ${groupUsed} est equilibre sur ${name}.`;
}

function formatNumber(value) {
  return new Intl.NumberFormat('fr-FR').format(Number(value || 0));
}

function formatDateFr(input) {
  if (!input) return 'date CFTC inconnue';
  const d = new Date(input);
  if (!Number.isNaN(d.getTime())) return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const m = String(input).match(/^(\d{2})(\d{2})(\d{2})$/);
  if (m) {
    const date = new Date(Number(`20${m[1]}`), Number(m[2]) - 1, Number(m[3]));
    return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  return input;
}

function getParisDateParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { weekday: map.weekday, hour: map.hour, minute: map.minute };
}

function getNextReleaseInfo(reports) {
  const latest = Array.isArray(reports) && reports.length ? reports[0] : null;
  let releaseUtc;

  if (latest && latest.reportDateRaw) {
    const positionDate = parseCftcDate(latest.reportDateRaw);
    if (positionDate) releaseUtc = newYorkReleaseDateToUtc(addDays(positionDate, 10));
  }

  if (!releaseUtc) releaseUtc = computeNextUpcomingReleaseUtc(new Date());

  return {
    iso: releaseUtc.toISOString(),
    label: formatReleaseForDisplay(releaseUtc),
    autoSyncLabel: 'Verification automatique au demarrage puis toutes les 15 minutes tant que l application reste ouverte.'
  };
}

function parseCftcDate(input) {
  if (!input) return null;
  const d = new Date(input);
  if (!Number.isNaN(d.getTime())) return d;
  const m = String(input).match(/^(\d{2})(\d{2})(\d{2})$/);
  if (m) return new Date(Date.UTC(Number(`20${m[1]}`), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  return null;
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function computeNextUpcomingReleaseUtc(now) {
  const parisParts = getDatePartsInZone(now, 'Europe/Paris');
  const todayParis = new Date(Date.UTC(Number(parisParts.year), Number(parisParts.month) - 1, Number(parisParts.day), 12, 0, 0));
  const daysUntilFriday = (5 - todayParis.getUTCDay() + 7) % 7;
  let candidateDay = addDays(todayParis, daysUntilFriday);
  let candidateUtc = newYorkReleaseDateToUtc(candidateDay);
  if (now.getTime() >= candidateUtc.getTime()) {
    candidateDay = addDays(candidateDay, 7);
    candidateUtc = newYorkReleaseDateToUtc(candidateDay);
  }
  return candidateUtc;
}

function newYorkReleaseDateToUtc(dayDate) {
  const y = dayDate.getUTCFullYear();
  const m = dayDate.getUTCMonth();
  const d = dayDate.getUTCDate();
  const tryEdt = new Date(Date.UTC(y, m, d, 19, 30, 0));
  const hourEdt = getDatePartsInZone(tryEdt, 'America/New_York').hour;
  if (String(hourEdt).padStart(2, '0') === '15') return tryEdt;
  return new Date(Date.UTC(y, m, d, 20, 30, 0));
}

function getDatePartsInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
  }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function formatReleaseForDisplay(dateUtc) {
  const parisDate = dateUtc.toLocaleDateString('fr-FR', {
    timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  const parisTime = dateUtc.toLocaleTimeString('fr-FR', {
    timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit'
  });
  return `Prochain rapport COT : ${parisDate} a 15h30 ET / ${parisTime} Paris`;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveStatic(urlPath, res) {
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = path.normalize(filePath).replace(/^\.\.(\/|\\|$)/, '');
  const fullPath = path.join(PUBLIC_DIR, filePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) return notFound(res);

  fs.readFile(fullPath, (err, data) => {
    if (err) return notFound(res);
    const ext = path.extname(fullPath).toLowerCase();
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}
