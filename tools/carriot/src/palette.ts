/** State colours as xterm-256 indices, shared by every terminal surface (tmux badges, reins, picker) so they match. */
export const COLOUR = {
  blocked: 203,
  waiting: 214,
  planning: 75,
  working: 78,
  idle: 244,
} as const;

export const ansiFg = (n: number) => `\x1b[38;5;${n}m`;
