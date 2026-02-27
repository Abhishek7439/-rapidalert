/**
 * generate-icons.js
 * Creates RapidAlert PWA icons with 🚨 siren visual using pure Node.js
 * (no external dependencies — uses zlib for PNG compression)
 *
 * Run: node scripts/generate-icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICONS_DIR = path.join(__dirname, '..', 'rapidalert-citizen', 'icons');

// ── PNG encoder ──────────────────────────────────────────────────────────────
function crc32(buf) {
    const table = (() => {
        const t = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            t[i] = c;
        }
        return t;
    })();
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcInput = Buffer.concat([typeBytes, data]);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(crcInput));
    return Buffer.concat([len, typeBytes, data, crcBuf]);
}

function encodePNG(pixels, size) {
    // pixels: Uint8Array of RGBA values, row by row
    const raw = [];
    for (let y = 0; y < size; y++) {
        raw.push(0); // filter type: None
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            raw.push(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]);
        }
    }
    const compressed = zlib.deflateSync(Buffer.from(raw));
    const IHDR = Buffer.alloc(13);
    IHDR.writeUInt32BE(size, 0);
    IHDR.writeUInt32BE(size, 4);
    IHDR[8] = 8;   // bit depth
    IHDR[9] = 6;   // RGBA
    IHDR[10] = IHDR[11] = IHDR[12] = 0;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
        chunk('IHDR', IHDR),
        chunk('IDAT', compressed),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ── Icon painter ─────────────────────────────────────────────────────────────
function drawIcon(size, maskable = false) {
    const pixels = new Uint8Array(size * size * 4);

    const cx = size / 2;
    const cy = size / 2;
    const pad = maskable ? size * 0.12 : 0;  // safe-zone inset for maskable
    const innerSize = size - 2 * pad;
    const scale = innerSize / 512;            // design at 512, scale to output

    function setPixel(x, y, r, g, b, a = 255) {
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        const i = (Math.round(y) * size + Math.round(x)) * 4;
        pixels[i] = r;
        pixels[i + 1] = g;
        pixels[i + 2] = b;
        pixels[i + 3] = a;
    }

    // Antialiased circle fill helper
    function fillCircle(cx, cy, r, r2, g2, b2, a2 = 255) {
        const x0 = Math.floor(cx - r - 1), x1 = Math.ceil(cx + r + 1);
        const y0 = Math.floor(cy - r - 1), y1 = Math.ceil(cy + r + 1);
        for (let py = y0; py <= y1; py++) {
            for (let px = x0; px <= x1; px++) {
                const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
                const alpha = Math.max(0, Math.min(1, r - dist + 0.5));
                if (alpha > 0) {
                    const ia = Math.round(a2 * alpha);
                    const idx = (py * size + px) * 4;
                    if (px >= 0 && py >= 0 && px < size && py < size) {
                        pixels[idx] = r2;
                        pixels[idx + 1] = g2;
                        pixels[idx + 2] = b2;
                        pixels[idx + 3] = ia;
                    }
                }
            }
        }
    }

    // Fill rect helper
    function fillRect(x, y, w, h, r, g, b, a = 255) {
        for (let py = Math.floor(y); py < Math.ceil(y + h); py++) {
            for (let px = Math.floor(x); px < Math.ceil(x + w); px++) {
                if (px >= 0 && py >= 0 && px < size && py < size) {
                    const idx = (py * size + px) * 4;
                    pixels[idx] = r;
                    pixels[idx + 1] = g;
                    pixels[idx + 2] = b;
                    pixels[idx + 3] = a;
                }
            }
        }
    }

    // ── 1. Background: deep navy-black ───────────────────────────────────────
    if (maskable) {
        // For maskable: fill entire canvas with bg
        for (let i = 0; i < pixels.length; i += 4) {
            pixels[i] = 9; pixels[i + 1] = 11; pixels[i + 2] = 16; pixels[i + 3] = 255;
        }
    } else {
        // Rounded rect background (radius ~18%)
        const bgR = size * 0.18;
        for (let py = 0; py < size; py++) {
            for (let px = 0; px < size; px++) {
                const dx = Math.max(0, Math.max(bgR - px, px - (size - bgR)));
                const dy = Math.max(0, Math.max(bgR - py, py - (size - bgR)));
                const dist = Math.sqrt(dx * dx + dy * dy);
                const alpha = Math.max(0, Math.min(1, bgR - dist + 0.5));
                const idx = (py * size + px) * 4;
                pixels[idx] = 9;
                pixels[idx + 1] = 11;
                pixels[idx + 2] = 16;
                pixels[idx + 3] = Math.round(255 * alpha);
            }
        }
    }

    const s = scale;

    // ── 2. Siren base (grey housing) ────────────────────────────────────────
    // Dome top
    const domeCX = cx;
    const domeCY = cy - 60 * s;
    const domeR = 95 * s;
    fillCircle(domeCX, domeCY, domeR, 55, 60, 70, 255);

    // Housing body (trapezoid approximation via filled rects)
    fillRect(cx - 80 * s, cy - 40 * s, 160 * s, 80 * s, 55, 60, 70);

    // Base plate
    fillRect(cx - 90 * s, cy + 35 * s, 180 * s, 22 * s, 40, 44, 54);

    // ── 3. Red siren light (centre glow) ────────────────────────────────────
    // Outer glow
    fillCircle(domeCX, domeCY, 70 * s, 232, 50, 50, 80);
    // Middle
    fillCircle(domeCX, domeCY, 55 * s, 232, 50, 50, 180);
    // Bright core
    fillCircle(domeCX, domeCY, 40 * s, 255, 80, 60, 255);
    // Highlight
    fillCircle(domeCX - 12 * s, domeCY - 12 * s, 14 * s, 255, 200, 200, 200);

    // ── 4. Light rays (4 rays radiating out) ────────────────────────────────
    const rayColor = [255, 140, 50];
    const rays = [
        { angle: -60, len: 90 * s, w: 10 * s },
        { angle: 0, len: 100 * s, w: 12 * s },
        { angle: 60, len: 90 * s, w: 10 * s },
        { angle: 120, len: 75 * s, w: 8 * s },
    ];
    for (const { angle, len, w } of rays) {
        const rad = (angle - 90) * Math.PI / 180;
        const steps = Math.ceil(len);
        for (let t = domeR * 0.8; t < len + domeR; t++) {
            const tx = domeCX + Math.cos(rad) * t;
            const ty = domeCY + Math.sin(rad) * t;
            const alpha = Math.round(180 * (1 - (t - domeR * 0.8) / len));
            const hw = w * (1 - (t - domeR * 0.8) / (len + domeR) * 0.5);
            for (let perp = -hw; perp <= hw; perp++) {
                const perpRad = rad + Math.PI / 2;
                const px2 = Math.round(tx + Math.cos(perpRad) * perp);
                const py2 = Math.round(ty + Math.sin(perpRad) * perp);
                if (px2 >= 0 && py2 >= 0 && px2 < size && py2 < size) {
                    const idx = (py2 * size + px2) * 4;
                    pixels[idx] = rayColor[0];
                    pixels[idx + 1] = rayColor[1];
                    pixels[idx + 2] = rayColor[2];
                    pixels[idx + 3] = Math.max(0, Math.min(255, alpha));
                }
            }
        }
    }

    // ── 5. Siren ribbing lines on housing ───────────────────────────────────
    for (let i = 0; i < 3; i++) {
        const ly = cy - 30 * s + i * 20 * s;
        fillRect(cx - 75 * s, ly, 150 * s, 3 * s, 70, 76, 90);
    }

    return pixels;
}

// ── Generate all sizes ───────────────────────────────────────────────────────
const sizes = [
    { name: 'icon-72.png', size: 72, maskable: false },
    { name: 'icon-192.png', size: 192, maskable: false },
    { name: 'icon-192-maskable.png', size: 192, maskable: true },
    { name: 'icon-512.png', size: 512, maskable: false },
    { name: 'icon-512-maskable.png', size: 512, maskable: true },
];

if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR, { recursive: true });

for (const { name, size, maskable } of sizes) {
    const pixels = drawIcon(size, maskable);
    const png = encodePNG(pixels, size);
    fs.writeFileSync(path.join(ICONS_DIR, name), png);
    console.log(`✅ Generated: ${name} (${size}x${size}${maskable ? ' maskable' : ''})`);
}

console.log('\n🚨 All icons generated! Deploy to see them on mobile.');
