import fs from 'node:fs';

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) { console.error('用法: node mkcmd.mjs <in.js> <out.json>'); process.exit(1); }
const js = fs.readFileSync(inFile, 'utf8');
fs.writeFileSync(outFile, JSON.stringify({ cmd: 'eval', js }), 'utf8');
console.log(`${outFile} <- ${inFile} (${js.length} chars)`);
