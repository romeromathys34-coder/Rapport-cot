const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const STATIC_REPORTS_FILE = path.join(PUBLIC_DIR, 'reports-static.js');

const DATASETS = [
  {
    id: '6dca-aqww',
    label: 'Legacy Futures Only',
    reportFamily: 'Current Legacy Reports',
    reportType: 'Futures Only / Non-Commercial',
    groupUsed: 'Non-Commercial',
    categoryLabel: 'Non-Commercial',
    sourcePage: 'https://publicreporting.cftc.gov/resource/6dca-aqww.json',
    longFields: ['noncomm_positions_long_all', 'noncomm_positions_long'],
    shortFields: ['noncomm_positions_short_all', 'noncomm_positions_short'],
    spreadFields: ['noncomm_postions_spread_all', 'noncomm_positions_spread_all', 'noncomm_positions_spread']
  },
  {
    id: '72hh-3qpy',
    label: 'Disaggregated Futures Only',
    reportFamily: 'Current Disaggregated Reports',
    reportType: 'Futures Only / Managed Money',
    groupUsed: 'Managed Money',
    categoryLabel: 'Managed Money',
    sourcePage: 'https://publicreporting.cftc.gov/resource/72hh-3qpy.json',
    longFields: ['m_money_positions_long_all', 'm_money_positions_long'],
    shortFields: ['m_money_positions_short_all', 'm_money_positions_short'],
    spreadFields: ['m_money_positions_spread_all', 'm_money_positions_spread']
  },
  {
    id: 'gpe5-46if',
    label: 'Traders in Financial Futures',
    reportFamily: 'Current Traders in Financial Futures Reports',
    reportType: 'Futures Only / Leveraged Funds',
    groupUsed: 'Leveraged Funds',
    categoryLabel: 'Leveraged Funds',
    sourcePage: 'https://publicreporting.cftc.gov/resource/gpe5-46if.json',
    longFields: ['lev_money_positions_long_all', 'lev_money_positions_long'],
    shortFields: ['lev_money_positions_short_all', 'lev_money_positions_short'],
    spreadFields: ['lev_money_positions_spread_all', 'lev_money_positions_spread']
  }
];

main().catch(error => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const assets = [];

  for (const dataset of DATASETS) {
    const latestDate = await fetchLatestDate(dataset.id);
    const rows = await fetchRowsForDate(dataset.id, latestDate);
    for (const row of rows) {
      const asset = toAsset(row, dataset, latestDate);
      if (asset) assets.push(asset);
    }
  }

  if (!assets.length) throw new Error('Aucun actif CFTC recupere depuis l API officielle.');

  const reportDateRaw = assets[0].reportDateRaw;
  const report = {
    id: `cot-api-${reportDateRaw}`.replace(/[^a-zA-Z0-9_-]/g, '-'),
    label: `Rapport COT complet du ${formatDateFr(reportDateRaw)}`,
    reportDateRaw,
    generatedAt: new Date().toLocaleString('fr-FR'),
    source: 'CFTC Public Reporting Environment',
    reportFamily: 'Legacy + Disaggregated + Traders in Financial Futures',
    reportType: 'Futures Only',
    format: 'CFTC API',
    groupUsed: 'Selon la liste CFTC',
    summary: `${assets.length} lignes CFTC indexees depuis l API officielle.`,
    assets: assets.sort((a, b) => a.name.localeCompare(b.name) || a.reportFamily.localeCompare(b.reportFamily))
  };

  fs.writeFileSync(STATIC_REPORTS_FILE, `window.COT_REPORTS = ${JSON.stringify([report])};\n`, 'utf8');
  console.log(`Rapport COT mis a jour : ${report.assets.length} lignes (${report.reportDateRaw})`);
}
async function fetchLatestDate(datasetId) {
  const url = new URL(`https://publicreporting.cftc.gov/resource/${datasetId}.json`);
  url.searchParams.set('$select', 'report_date_as_yyyy_mm_dd');
  url.searchParams.set('$order', 'report_date_as_yyyy_mm_dd DESC');
  url.searchParams.set('$limit', '1');

  const rows = await fetchJson(url);
  const latest = rows[0] && rows[0].report_date_as_yyyy_mm_dd;
  if (!latest) throw new Error(`Date CFTC introuvable pour ${datasetId}`);
  return latest;
}

async function fetchRowsForDate(datasetId, latestDate) {
  const url = new URL(`https://publicreporting.cftc.gov/resource/${datasetId}.json`);
  url.searchParams.set('report_date_as_yyyy_mm_dd', latestDate);
  url.searchParams.set('$limit', '50000');
  return fetchJson(url);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'cot-sync-github-pages/1.0'
    }
  });
  if (!response.ok) throw new Error(`CFTC API ${response.status} : ${url}`);
  return response.json();
}

function toAsset(row, dataset, reportDateRaw) {
  const marketName = clean(row.market_and_exchange_names || row.contract_market_name);
  if (!marketName) return null;

  const longPositions = numberFromFields(row, dataset.longFields);
  const shortPositions = numberFromFields(row, dataset.shortFields);
  const spreadPositions = numberFromFields(row, dataset.spreadFields);
  const openInterest = Number(row.open_interest_all || 0);
  const netPosition = longPositions - shortPositions;
  const score = Math.sign(netPosition);
  const name = clean(row.contract_market_name || marketName.split(' - ')[0] || marketName);

  return {
    id: `${dataset.id}-${clean(row.id || row.cftc_contract_market_code || name)}-${reportDateRaw}`.replace(/[^a-zA-Z0-9_-]/g, '-'),
    name,
    symbol: clean(row.cftc_contract_market_code || row.cftc_market_code || ''),
    category: categoryForMarket(marketName),
    available: true,
    sourcePage: dataset.sourcePage,
    sourceLabel: dataset.label,
    marketName,
    market: marketName,
    marketCode: clean(row.cftc_contract_market_code || ''),
    exchangeCode: clean(row.cftc_market_code || ''),
    reportDateRaw,
    reportDate: formatDateFr(reportDateRaw),
    reportFamily: dataset.reportFamily,
    reportType: dataset.reportType,
    format: 'CFTC API',
    groupUsed: dataset.categoryLabel,
    formula: `Position nette = ${dataset.categoryLabel} Long - ${dataset.categoryLabel} Short`,
    longPositions,
    shortPositions,
    spreadPositions,
    openInterest,
    netPosition,
    weeklyChange: 'Mis a jour via API CFTC',
    score,
    bias: biasLabel(score),
    explanation: score > 0
      ? `Le groupe ${dataset.categoryLabel} est davantage acheteur que vendeur sur ${name}.`
      : score < 0
        ? `Le groupe ${dataset.categoryLabel} est davantage vendeur qu acheteur sur ${name}.`
        : `Le groupe ${dataset.categoryLabel} est neutre sur ${name}.`
  };
}
function numberFromFields(row, fields) {
  for (const field of fields) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== '') return Number(row[field] || 0);
  }
  return 0;
}

function clean(value) {
  return String(value || '').trim();
}

function biasLabel(score) {
  if (score > 0) return 'Haussier';
  if (score < 0) return 'Baissier';
  return 'Neutre';
}

function formatDateFr(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return clean(value);
  return date.toLocaleDateString('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
}

function categoryForMarket(market) {
  const text = market.toLowerCase();
  if (/bitcoin|ether|crypto/.test(text)) return 'Cryptomonnaies';
  if (/gold|silver|copper|platinum|palladium|metal/.test(text)) return 'Metaux';
  if (/crude|oil|gas|heating|gasoline|petroleum|brent|wti/.test(text)) return 'Energie';
  if (/wheat|corn|soy|coffee|sugar|cotton|cocoa|cattle|hog|milk|rice|oats/.test(text)) return 'Agriculture';
  if (/dollar|euro|yen|franc|pound|peso|real|rand|currency|fx/.test(text)) return 'Devises';
  if (/treasury|bond|note|rate|fed|sofr|eurodollar/.test(text)) return 'Taux';
  if (/s&p|nasdaq|dow|russell|index|vix/.test(text)) return 'Indices';
  return 'Autres';
}
