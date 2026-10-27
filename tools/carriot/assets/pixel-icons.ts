// Generates carriot's pixel-art icon (icon.svg, icon.png, icon.icns) and the alternative scene design.
//   bun tools/carriot/assets/pixel-icons.ts
// Palette follows the logo: night-purple sky, cyan neon rod, brass chariot, carrot orange.

const P = {
  bg: "#1b1533",
  bgHi: "#241c45",
  brass: "#d9a441",
  brassHi: "#f5d27a",
  brassLo: "#9a6b22",
  hub: "#5b3a12",
  neon: "#38bdf8",
  neonHi: "#e0f2fe",
  string: "#cbd5e1",
  leaf: "#4ade80",
  leafLo: "#16a34a",
  carrot: "#fb923c",
  carrotHi: "#fdba74",
  carrotLo: "#ea580c",
  horse: "#f1f5f9",
  horseLo: "#94a3b8",
  eye: "#1e1b2e",
  car: "#7c3aed",
  carLo: "#5b21b6",
  crest: "#ef4444",
  helm: "#e2b85c",
  pole: "#8b5a2b",
  dust: "#6b4f8a",
  dustHi: "#8a6aa8",
} as const;

type Color = (typeof P)[keyof typeof P];
type Grid = (Color | null)[][];

const SIZE = 32;
const grid = (): Grid => Array.from({ length: SIZE }, () => Array<Color | null>(SIZE).fill(null));
const put = (g: Grid, x: number, y: number, c: Color) => {
  if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) g[Math.round(y)][Math.round(x)] = c;
};

/** Rounded-square tile with the pixel corners cut, like an app icon. */
function background(g: Grid) {
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const cx = Math.min(x, SIZE - 1 - x);
      const cy = Math.min(y, SIZE - 1 - y);
      if (cx + cy < 3) continue;
      g[y][x] = y < SIZE / 2 ? P.bgHi : P.bg;
    }
}

function line(g: Grid, x0: number, y0: number, x1: number, y1: number, c: Color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= steps; i++) put(g, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, c);
}

/** Chariot wheel: brass rim lit from the top-left, eight spokes, dark hub. */
function wheel(g: Grid, cx: number, cy: number, r: number) {
  for (let a = 0; a < 8; a++) {
    const t = (a * Math.PI) / 4;
    line(g, cx, cy, cx + Math.cos(t) * (r - 1), cy + Math.sin(t) * (r - 1), P.brassLo);
  }
  for (let y = -r - 1; y <= r + 1; y++)
    for (let x = -r - 1; x <= r + 1; x++) {
      const d = Math.hypot(x, y);
      if (d > r + 0.5 || d < r - 1.1) continue;
      const lit = x + y < -r * 0.4;
      const shade = x + y > r * 0.6;
      put(g, cx + x, cy + y, lit ? P.brassHi : shade ? P.brassLo : P.brass);
    }
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) put(g, cx + x, cy + y, P.brassHi);
  put(g, cx, cy, P.hub);
}

/** Carrots drawn as pixel maps: l/L leaves, H highlight, o body, D shaded side, x ridge. */
const CARROT_LARGE = [
  "l..l",
  ".lL.",
  "lLl.",
  "HooD",
  "HoxD",
  "HooD",
  ".HoD",
  ".oxD",
  ".oD.",
  ".oD.",
  "..D.",
];
const CARROT_SMALL = ["l.l", ".L.", "HoD", "HoD", "HxD", ".oD", ".o.", ".D."];
const CARROT_COLORS = { l: P.leaf, L: P.leafLo, H: P.carrotHi, o: P.carrot, D: P.carrotLo, x: P.carrotLo } as const;

/** Galloping horse facing right, 16x12, drawn from a pixel map. */
const HORSE = [
  "..........w.w...",
  ".........wWWW...",
  "........wWWkWW..",
  ".......wWWW.WWW.",
  "......wWWW...WWW",
  "ww...wWWWW......",
  ".wwWWWWWWWW.....",
  "..WWWWWWWWWW....",
  "..WWWWWWWWWW....",
  "...wWW....WWw...",
  "..W..W......W.W.",
  ".w....w......w..w",
];

/** Chariot car (front guard rising on the right) with the rider: crest, helmet, cape, armour. */
const CHARIOT = [
  "...cc.....",
  "..cHHc....",
  "...HH.....",
  "..RAAR....",
  ".RRAAR...n",
  "nnnnnnnnnN",
  "PPPPPPPPPN",
  "PPPPPPPPpN",
  ".PPPPPPpp.",
];
const CHARIOT_COLORS = { c: P.crest, H: P.helm, R: P.crest, A: P.carLo, n: P.neon, N: P.neonHi, P: P.car, p: P.carLo } as const;

function sprite(g: Grid, rows: string[], ox: number, oy: number, colors: Record<string, Color>) {
  rows.forEach((row, y) => [...row].forEach((ch, x) => colors[ch] && put(g, ox + x, oy + y, colors[ch])));
}

/** One rect per run of same-coloured pixels in a row: crisp at any size and a fraction of one rect per pixel. */
function svg(g: Grid): string {
  const rects: string[] = [];
  g.forEach((row, y) => {
    for (let x = 0; x < SIZE; ) {
      const c = row[x];
      let end = x + 1;
      while (end < SIZE && row[end] === c) end++;
      if (c) rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${c}"/>`);
      x = end;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" shape-rendering="crispEdges">${rects.join("")}</svg>\n`;
}

/** Option A: chariot wheel with the carrot dangling from the neon rod. Reads at 16px. */
function wheelIcon(): Grid {
  const g = grid();
  background(g);
  wheel(g, 12, 19, 9);
  line(g, 3, 9, 25, 3, P.neon);
  put(g, 25, 3, P.neonHi);
  line(g, 25, 4, 25, 6, P.string);
  sprite(g, CARROT_LARGE, 24, 7, CARROT_COLORS);
  return g;
}

/** Option B: the scene: charioteer, chariot, a galloping horse and the carrot ahead of it. */
function sceneIcon(): Grid {
  const g = grid();
  background(g);
  for (let x = 2; x < 30; x++) put(g, x, 27, x % 3 ? P.dust : P.dustHi);
  for (let x = 4; x < 28; x += 4) put(g, x, 28, P.dust);
  sprite(g, CHARIOT, 2, 10, CHARIOT_COLORS);
  line(g, 11, 18, 15, 19, P.pole);
  wheel(g, 7, 22, 4);
  sprite(g, HORSE, 14, 15, { W: P.horse, w: P.horseLo, k: P.eye });
  line(g, 7, 13, 28, 3, P.neon);
  put(g, 28, 3, P.neonHi);
  put(g, 28, 4, P.string);
  sprite(g, CARROT_SMALL, 27, 5, CARROT_COLORS);
  return g;
}

/** Raw 32x32 RGBA, for scaling into PNGs with nearest-neighbour (SVG rasterisers blur 1px rects). */
function rgba(g: Grid): Uint8Array {
  const buf = new Uint8Array(SIZE * SIZE * 4);
  g.forEach((row, y) =>
    row.forEach((c, x) => {
      if (!c) return;
      const i = (y * SIZE + x) * 4;
      buf.set([parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 255], i);
    }),
  );
  return buf;
}

/**
 * PNG and macOS .icns for the chosen icon, scaled from the raw pixels with nearest-neighbour (only 16px, smaller than
 * the grid, is smoothed). Needs ImageMagick (`magick`) and `iconutil`.
 */
async function rasterise(g: Grid, dir: string) {
  const tmp = `${process.env.TMPDIR ?? "/tmp"}/carriot-icon-${process.pid}`;
  const set = `${tmp}/carriot.iconset`;
  await Bun.$`mkdir -p ${set}`;
  await Bun.write(`${tmp}/icon.rgba`, rgba(g));
  const scale = (size: number, file: string) =>
    Bun.$`magick -size ${SIZE}x${SIZE} -depth 8 rgba:${tmp}/icon.rgba ${size < SIZE ? [] : ["-filter", "point"]} -resize ${size}x${size} ${file}`;
  await scale(512, `${dir}icon.png`);
  for (const [name, size] of [
    ["16x16", 16], ["16x16@2x", 32], ["32x32", 32], ["32x32@2x", 64], ["128x128", 128],
    ["128x128@2x", 256], ["256x256", 256], ["256x256@2x", 512], ["512x512", 512], ["512x512@2x", 1024],
  ] as const)
    await scale(size, `${set}/icon_${name}.png`);
  await Bun.$`iconutil -c icns ${set} -o ${dir}icon.icns`;
  await Bun.$`rm -rf ${tmp}`;
}

const out = new URL(".", import.meta.url).pathname;
// The wheel is carriot's icon; the scene stays as the alternative design.
const icon = wheelIcon();
await Bun.write(`${out}icon.svg`, svg(icon));
await Bun.write(`${out}pixel-scene.svg`, svg(sceneIcon()));
await rasterise(icon, out);
console.log("wrote icon.svg, icon.png, icon.icns and pixel-scene.svg");
