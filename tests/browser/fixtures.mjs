// Files to import in the browser tests. Written rather than committed:
// a binary fixture in git is a thing to explain, and these are three
// lines of code each.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { TMP } from './harness.mjs';

const DIR = path.join(TMP, 'fixtures');

function png() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  // Node 22 has zlib.crc32; this keeps the fixture working without it.
  function crc32(buf) {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.concat(Array.from({ length: 4 }, () => Buffer.concat([Buffer.from([0]), Buffer.from('\x20\x40\x60'.repeat(4), 'binary')])));
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function writeFixtures() {
  fs.mkdirSync(DIR, { recursive: true });
  const at = (name) => path.join(DIR, name);

  fs.writeFileSync(at('plate.png'), png());
  fs.writeFileSync(at('scene-4.fountain'), 'INT. TRUCK - DAY\n\nWES\nWe go at first light.\n');
  fs.writeFileSync(at('treatment.pdf'), Buffer.concat([Buffer.from('%PDF-1.4\n% a stand-in\n'), Buffer.alloc(2048, 0x30)]));
  // Over the 1.5 MB chunk size, so reassembly is actually exercised.
  fs.writeFileSync(at('big.bin'), Buffer.from(Array.from({ length: 3.2 * 1024 * 1024 | 0 }, (_, i) => i % 256)));

  return {
    dir: DIR,
    png: at('plate.png'),
    script: at('scene-4.fountain'),
    pdf: at('treatment.pdf'),
    big: at('big.bin'),
    sizeOf: (p) => fs.statSync(p).size,
  };
}
