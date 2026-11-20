// The World in One Day — 20 November 2026.
// A Node 22, standard-library-only program that draws a 1024x1024 newspaper
// front page summing up Friday 20 November 2026's world news and writes it to
// /output/entry.png (or $MAKEFUN_OUTPUT_DIR/entry.png). No network, no
// randomness: the output bytes are identical on every run.
//
// Every word on the image is rendered by code with a small built-in 5x7
// bitmap font, scaled up. The picture is drawn with plain rectangles,
// circles and lines, so nothing depends on a font or image file on disk.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// PNG encoding (truecolour RGB, 8 bit). Written from the PNG spec by hand:
// signature, IHDR, IDAT (zlib-deflated scanlines, filter 0), IEND.
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter: none
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + width * 3) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Canvas: a plain RGB raster with rectangle, circle and line drawing.
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

class Canvas {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;

  constructor(w: number, h: number, bg: RGB) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 3);
    this.fillRect(0, 0, w, h, bg);
  }

  set(x: number, y: number, c: RGB): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = c[0];
    this.px[i + 1] = c[1];
    this.px[i + 2] = c[2];
  }

  fillRect(x: number, y: number, w: number, h: number, c: RGB): void {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.w, x + w);
    const y1 = Math.min(this.h, y + h);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const i = (yy * this.w + xx) * 3;
        this.px[i] = c[0];
        this.px[i + 1] = c[1];
        this.px[i + 2] = c[2];
      }
    }
  }

  // Outline rectangle, 1px border.
  strokeRect(x: number, y: number, w: number, h: number, c: RGB): void {
    this.fillRect(x, y, w, 1, c);
    this.fillRect(x, y + h - 1, w, 1, c);
    this.fillRect(x, y, 1, h, c);
    this.fillRect(x + w - 1, y, 1, h, c);
  }

  fillCircle(cx: number, cy: number, r: number, c: RGB): void {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) this.set(x, y, c);
      }
    }
  }

  strokeCircle(cx: number, cy: number, r: number, c: RGB): void {
    for (let a = 0; a < 360; a++) {
      const rad = (a * Math.PI) / 180;
      this.set(Math.round(cx + r * Math.cos(rad)), Math.round(cy + r * Math.sin(rad)), c);
    }
  }

  // Bresenham line, thickness 1.
  line(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (;;) {
      this.set(x, y, c);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  // Thick line drawn as a stack of parallel 1px lines.
  thickLine(x0: number, y0: number, x1: number, y1: number, t: number, c: RGB): void {
    const half = Math.floor(t / 2);
    for (let o = -half; o <= half; o++) this.line(x0, y0 + o, x1, y1 + o, c);
  }
}

// ---------------------------------------------------------------------------
// Bitmap font: 5x7 glyphs, each row a 5-bit number (bit 4 = leftmost pixel).
// Only the characters the poster uses are defined; everything is rendered
// in capitals, so the table covers A-Z, 0-9 and common punctuation.
// ---------------------------------------------------------------------------

const FONT: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x0e, 0x10, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x01, 0x0e],
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  ',': [0x00, 0x00, 0x00, 0x00, 0x0c, 0x04, 0x08],
  '-': [0x00, 0x00, 0x00, 0x0e, 0x00, 0x00, 0x00],
  "'": [0x04, 0x04, 0x08, 0x00, 0x00, 0x00, 0x00],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
  '?': [0x0e, 0x11, 0x01, 0x06, 0x04, 0x00, 0x04],
  ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  ';': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x04, 0x08],
  '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '&': [0x0c, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0d],
  '%': [0x19, 0x1a, 0x02, 0x04, 0x08, 0x16, 0x13],
  $: [0x04, 0x0f, 0x14, 0x0e, 0x05, 0x1e, 0x04],
  '+': [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  '=': [0x00, 0x00, 0x1f, 0x00, 0x1f, 0x00, 0x00],
  '"': [0x0a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00],
};

// Normalise text to the characters the font knows.
function normalise(text: string): string {
  return text
    .toUpperCase()
    .replace(/[–—]/g, '-')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/·/g, '-');
}

function textWidth(text: string, scale: number): number {
  const t = normalise(text);
  if (t.length === 0) return 0;
  return t.length * (5 * scale + scale) - scale;
}

// Draw one line of text at (x, y); returns the width drawn.
function drawText(cv: Canvas, text: string, x: number, y: number, scale: number, c: RGB): number {
  const t = normalise(text);
  let cx = x;
  for (const ch of t) {
    const glyph = FONT[ch] ?? FONT['?'];
    for (let row = 0; row < 7; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col++) {
        if (bits & (1 << (4 - col))) {
          cv.fillRect(cx + col * scale, y + row * scale, scale, scale, c);
        }
      }
    }
    cx += 5 * scale + scale;
  }
  return cx - x - scale;
}

// Greedy word wrap: returns lines that fit within maxWidth.
function wrapText(text: string, scale: number, maxWidth: number): string[] {
  const words = normalise(text).split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const trial = cur === '' ? w : cur + ' ' + w;
    if (textWidth(trial, scale) <= maxWidth) {
      cur = trial;
    } else {
      if (cur !== '') lines.push(cur);
      cur = w;
    }
  }
  if (cur !== '') lines.push(cur);
  return lines;
}

// Draw wrapped text; returns the y just below the last line.
function drawParagraph(
  cv: Canvas,
  text: string,
  x: number,
  y: number,
  scale: number,
  maxWidth: number,
  lineHeight: number,
  c: RGB,
  maxLines = 99,
): number {
  const lines = wrapText(text, scale, maxWidth).slice(0, maxLines);
  let yy = y;
  for (const line of lines) {
    drawText(cv, line, x, yy, scale, c);
    yy += lineHeight;
  }
  return yy;
}

// Draw text centred on cx.
function drawCentred(cv: Canvas, text: string, cx: number, y: number, scale: number, c: RGB): void {
  const w = textWidth(text, scale);
  drawText(cv, text, cx - Math.floor(w / 2), y, scale, c);
}

// ---------------------------------------------------------------------------
// Palette and layout.
// ---------------------------------------------------------------------------

const INK: RGB = [13, 27, 46]; // deep navy page background
const PANEL: RGB = [22, 40, 63]; // panel background
const PANEL_EDGE: RGB = [58, 84, 118]; // panel border
const PAPER: RGB = [244, 241, 232]; // off-white headline text
const MUTED: RGB = [176, 190, 205]; // summary text
const GOLD: RGB = [212, 175, 55]; // masthead gold
const RULE: RGB = [90, 112, 140]; // thin rules

const W = 1024;
const H = 1024;
const MARGIN = 28;

// ---------------------------------------------------------------------------
// Small pictograms, one per story, drawn in the panel's accent colour.
// Each fits in a 54x54 box whose top-left is (x, y).
// ---------------------------------------------------------------------------

function iconScales(cv: Canvas, x: number, y: number, c: RGB): void {
  // Scales of justice: post, beam, two pans.
  cv.thickLine(x + 27, y + 6, x + 27, y + 46, 3, c);
  cv.thickLine(x + 6, y + 12, x + 48, y + 12, 3, c);
  cv.fillRect(x + 22, y + 4, 10, 4, c);
  cv.line(x + 8, y + 12, x + 2, y + 30, c);
  cv.line(x + 8, y + 12, x + 14, y + 30, c);
  cv.line(x + 46, y + 12, x + 40, y + 30, c);
  cv.line(x + 46, y + 12, x + 52, y + 30, c);
  cv.fillRect(x + 1, y + 30, 14, 3, c);
  cv.fillRect(x + 39, y + 30, 14, 3, c);
  cv.fillRect(x + 18, y + 46, 18, 4, c);
}

function iconGlobe(cv: Canvas, x: number, y: number, c: RGB): void {
  cv.strokeCircle(x + 27, y + 27, 21, c);
  cv.strokeCircle(x + 27, y + 27, 21, c);
  cv.line(x + 6, y + 27, x + 48, y + 27, c);
  cv.line(x + 27, y + 6, x + 27, y + 48, c);
  // Meridian ellipse hint: two arcs.
  for (let a = -70; a <= 70; a += 6) {
    const rad = (a * Math.PI) / 180;
    cv.set(Math.round(x + 27 + 11 * Math.cos(rad)), Math.round(y + 27 + 21 * Math.sin(rad)), c);
    cv.set(Math.round(x + 27 - 11 * Math.cos(rad)), Math.round(y + 27 + 21 * Math.sin(rad)), c);
  }
}

function iconBlast(cv: Canvas, x: number, y: number, c: RGB): void {
  // Starburst: eight rays from the centre, with a solid core.
  const cx = x + 27;
  const cy = y + 27;
  for (let k = 0; k < 8; k++) {
    const rad = (k * Math.PI) / 4;
    cv.thickLine(
      Math.round(cx + 9 * Math.cos(rad)),
      Math.round(cy + 9 * Math.sin(rad)),
      Math.round(cx + 24 * Math.cos(rad)),
      Math.round(cy + 24 * Math.sin(rad)),
      3,
      c,
    );
  }
  cv.fillCircle(cx, cy, 8, c);
}

function iconTower(cv: Canvas, x: number, y: number, c: RGB): void {
  // Skyscraper with lit windows and a strike flash above it.
  cv.fillRect(x + 18, y + 14, 18, 36, c);
  cv.fillRect(x + 23, y + 8, 8, 6, c);
  cv.fillRect(x + 21, y + 20, 3, 3, INK);
  cv.fillRect(x + 28, y + 20, 3, 3, INK);
  cv.fillRect(x + 21, y + 28, 3, 3, INK);
  cv.fillRect(x + 28, y + 28, 3, 3, INK);
  cv.fillRect(x + 21, y + 36, 3, 3, INK);
  cv.fillRect(x + 28, y + 36, 3, 3, INK);
  cv.fillRect(x + 21, y + 44, 3, 3, INK);
  cv.fillRect(x + 28, y + 44, 3, 3, INK);
  cv.fillRect(x + 14, y + 50, 26, 3, c);
  // Small flash above the roof.
  cv.thickLine(x + 40, y + 2, x + 46, y + 10, 2, GOLD);
  cv.thickLine(x + 46, y + 2, x + 40, y + 10, 2, GOLD);
}

function iconChart(cv: Canvas, x: number, y: number, c: RGB): void {
  // Axes and a jagged market line ending down.
  cv.thickLine(x + 6, y + 6, x + 6, y + 48, 2, c);
  cv.thickLine(x + 6, y + 48, x + 50, y + 48, 2, c);
  const pts: [number, number][] = [
    [8, 34],
    [16, 28],
    [24, 30],
    [32, 20],
    [40, 24],
    [48, 40],
  ];
  for (let i = 0; i < pts.length - 1; i++) {
    cv.thickLine(x + pts[i][0], y + pts[i][1], x + pts[i + 1][0], y + pts[i + 1][1], 3, c);
  }
  // Arrowhead on the last segment.
  cv.thickLine(x + 48, y + 40, x + 44, y + 40, 2, c);
  cv.thickLine(x + 48, y + 40, x + 48, y + 36, 2, c);
}

function iconStars(cv: Canvas, x: number, y: number, c: RGB): void {
  // Ring of twelve stars, as on the European flag.
  for (let k = 0; k < 12; k++) {
    const rad = (k * Math.PI) / 6 - Math.PI / 2;
    const sx = Math.round(x + 27 + 18 * Math.cos(rad));
    const sy = Math.round(y + 27 + 18 * Math.sin(rad));
    cv.fillRect(sx - 2, sy - 2, 5, 5, c);
  }
  cv.fillCircle(x + 27, y + 27, 6, c);
}

type IconFn = (cv: Canvas, x: number, y: number, c: RGB) => void;

interface Story {
  tag: string;
  accent: RGB;
  icon: IconFn;
  headline: string;
  summary: string;
}

// Friday 20 November 2026, as reported that day. Every fact below was
// confirmed in more than one news source published on the day.
const STORIES: Story[] = [
  {
    tag: 'JUSTICE - THE HAGUE',
    accent: [212, 175, 55],
    icon: iconScales,
    headline: 'WORLD COURT: MYANMAR COMMITTED GENOCIDE',
    summary:
      'THE ICJ RULES MYANMAR COMMITTED GENOCIDE AGAINST THE ROHINGYA - A FIRST. 9-6.',
  },
  {
    tag: 'SUMMIT - SHENZHEN',
    accent: [96, 165, 250],
    icon: iconGlobe,
    headline: 'TRUMP, XI AND PUTIN MEET IN SHENZHEN',
    summary:
      'THE THREE LEADERS HOLD THEIR FIRST THREE-WAY SUMMIT AND SIGN A JOINT PEACE DECLARATION IN SHENZHEN.',
  },
  {
    tag: 'WAR - UKRAINE',
    accent: [239, 68, 68],
    icon: iconBlast,
    headline: 'RUSSIAN STRIKES HIT KYIV; 8 KILLED',
    summary:
      'OVERNIGHT MISSILES TARGET BRIDGES IN THE CAPITAL. 28 PEOPLE ARE INJURED IN ATTACKS ACROSS NINE REGIONS.',
  },
  {
    tag: 'MIDDLE EAST - RIYADH',
    accent: [249, 115, 22],
    icon: iconTower,
    headline: 'HOUTHI MISSILES DAMAGE RIYADH TOWER',
    summary:
      "MISSILES HIT RIYADH'S FINANCIAL DISTRICT AND DAMAGE THE PUBLIC INVESTMENT FUND TOWER.",
  },
  {
    tag: 'MARKETS - NEW YORK',
    accent: [74, 222, 128],
    icon: iconChart,
    headline: "ANTHROPIC'S RECORD IPO; STOCKS SLIDE",
    summary:
      'SHARES CLOSE 17% ABOVE THE $83 OFFER PRICE. S&P 500 FALLS A FIFTH DAY; NIKKEI DROPS 4.8%.',
  },
  {
    tag: 'EUROPE - BRUSSELS',
    accent: [167, 139, 250],
    icon: iconStars,
    headline: 'EU AND UK AGREE NEW DEALS IN BRUSSELS',
    summary:
      'LEADERS HOLD THEIR SECOND POST-BREXIT SUMMIT AND AGREE DEALS ON TRADE AND YOUTH MOBILITY.',
  },
];

const ALSO_TODAY =
  'ALSO TODAY: KENYA DISCHARGES ITS LAST EBOLA PATIENT, 37 DAYS AFTER ITS FIRST CASE - AND GTA VI LAUNCHES TO A 99 METASCORE.';

// ---------------------------------------------------------------------------
// Drawing the front page.
// ---------------------------------------------------------------------------

function drawStoryPanel(cv: Canvas, s: Story, x: number, y: number, w: number, h: number): void {
  cv.fillRect(x, y, w, h, PANEL);
  cv.strokeRect(x, y, w, h, PANEL_EDGE);
  cv.fillRect(x, y, w, 6, s.accent);

  const pad = 18;
  const innerW = w - pad * 2;
  const iconBox = 54;
  const textX = x + pad;
  const iconX = x + w - pad - iconBox;
  const iconY = y + 16;

  // Tag line, with the icon to its right.
  drawText(cv, s.tag, textX, y + 22, 2, s.accent);
  s.icon(cv, iconX, iconY, s.accent);

  // Headline, up to 3 lines, kept clear of the icon.
  const headW = iconX - textX - 12;
  drawParagraph(cv, s.headline, textX, y + 58, 3, headW, 30, PAPER, 3);

  // Summary, up to 3 lines, full inner width.
  drawParagraph(cv, s.summary, textX, y + 158, 2, innerW, 22, MUTED, 3);
}

function drawPage(): Buffer {
  const cv = new Canvas(W, H, INK);

  // Faint dotted texture on the page background.
  for (let y = 8; y < H; y += 32) {
    for (let x = 8; x < W; x += 32) {
      cv.set(x, y, [20, 38, 60]);
    }
  }

  // Masthead.
  drawCentred(cv, 'THE WORLD IN ONE DAY', W / 2, 34, 2, GOLD);
  drawCentred(cv, 'FRIDAY 20 NOVEMBER 2026', W / 2, 66, 6, PAPER);
  cv.fillRect(MARGIN, 132, W - MARGIN * 2, 3, GOLD);
  drawCentred(
    cv,
    'SIX STORIES THAT DEFINED THE DAY - FROM THE HAGUE TO SHENZHEN',
    W / 2,
    148,
    2,
    MUTED,
  );

  // Story grid: 2 columns x 3 rows.
  const gridTop = 186;
  const gridW = W - MARGIN * 2;
  const gap = 16;
  const panelW = Math.floor((gridW - gap) / 2);
  const panelH = 236;
  for (let i = 0; i < STORIES.length; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    drawStoryPanel(
      cv,
      STORIES[i],
      MARGIN + col * (panelW + gap),
      gridTop + row * (panelH + gap),
      panelW,
      panelH,
    );
  }

  // Footer strip.
  const footTop = gridTop + 3 * panelH + 2 * gap + 14;
  cv.fillRect(MARGIN, footTop, gridW, 1, RULE);
  drawParagraph(cv, ALSO_TODAY, MARGIN, footTop + 14, 2, gridW, 22, PAPER, 2);

  return encodePng(W, H, cv.px);
}

function main(): void {
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'entry.png'), drawPage());
}

main();
