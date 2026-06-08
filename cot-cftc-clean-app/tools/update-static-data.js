const { syncLatestReport } = require('../../server');

syncLatestReport({ force: true, reason: 'github-pages-auto' })
  .then(result => {
    const count = result.report && result.report.assets ? result.report.assets.length : 0;
    console.log(`Rapport COT mis a jour : ${count} lignes`);
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
