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
