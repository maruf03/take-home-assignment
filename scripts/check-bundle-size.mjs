/* global console */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

const MAX_GZIP_BYTES = 200 * 1024;
const assetsDir = path.resolve(import.meta.dirname, '..', 'apps', 'web', 'dist', 'assets');
const jsFiles = readdirSync(assetsDir).filter((name) => name.endsWith('.js'));

if (jsFiles.length === 0) {
  console.error(`No JS bundles found in ${assetsDir}; run pnpm --filter @app/web build first.`);
  process.exit(1);
}

let totalGzipBytes = 0;
for (const file of jsFiles) {
  const bytes = gzipSync(readFileSync(path.join(assetsDir, file))).length;
  totalGzipBytes += bytes;
  console.log(`${file}: ${(bytes / 1024).toFixed(2)} KB gzip`);
}

console.log(`Total initial JS: ${(totalGzipBytes / 1024).toFixed(2)} KB gzip (limit 200.00 KB)`);
if (totalGzipBytes > MAX_GZIP_BYTES) {
  console.error(`Bundle size ${totalGzipBytes} bytes exceeds ${MAX_GZIP_BYTES} bytes.`);
  process.exit(1);
}
