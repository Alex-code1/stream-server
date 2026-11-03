'use strict';
/* Isolated test: does the self-signed cert work with Node's https? */
const https = require('https');
const { ensureSelfSignedCert } = require('./server.js');

ensureSelfSignedCert().then((tls) => {
  if (!tls) {
    console.log('FAIL: ensureSelfSignedCert returned null');
    process.exit(1);
  }

  const srv = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  srv.listen(0, () => {
    const port = srv.address().port;
    const req = https.get(
      { host: '127.0.0.1', port, path: '/', rejectUnauthorized: false },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          console.log('HTTPS status:', res.statusCode, 'body:', body);
          console.log(res.statusCode === 200 ? 'PASS: self-signed cert works' : 'FAIL');
          srv.close();
          process.exit(res.statusCode === 200 ? 0 : 1);
        });
      }
    );
    req.on('error', (e) => {
      console.log('FAIL: https request error', e.message);
      srv.close();
      process.exit(1);
    });
  });
});
