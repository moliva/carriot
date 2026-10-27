/**
 * State colours as indices into the terminal's 16 theme colours, so a terminal colour scheme recolours every terminal
 * surface (tmux badges, reins, picker) together. 256-colour shades (16 and up) are fixed and would ignore the theme.
 */
export const COLOUR = {
  blocked: 1, // red
  waiting: 3, // yellow
  planning: 4, // blue
  working: 2, // green
  idle: 8, // bright black
} as const;

/** SGR foreground for a theme colour: 30-37 for 0-7, the bright 90-97 for 8-15. */
export const ansiFg = (n: number) => `\x1b[${n < 8 ? 30 + n : 82 + n}m`;

/** glow style built only from theme colours (glow's own styles hard-code 256-colour shades). */
export const GLOW_STYLE = `${import.meta.dir}/../glow-theme.json`;

/** delta flags that colour diffs with theme colours and highlight syntax with the terminal's own palette. */
export const DELTA_THEME = [
  "--syntax-theme=ansi",
  "--plus-style=green",
  "--minus-style=red",
  "--plus-emph-style=green bold reverse",
  "--minus-emph-style=red bold reverse",
  "--zero-style=normal",
  "--hunk-header-style=blue",
  "--file-style=yellow",
  "--file-decoration-style=yellow ul",
];
