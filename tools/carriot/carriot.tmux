# carriot tmux integration. Load it last from ~/.tmux.conf:
#   source-file -q ~/carriot/tools/carriot/carriot.tmux

# Append the state dot to whatever window formats the theme already set.
set -ga window-status-format " #{E:@carriot_badge}"
set -ga window-status-current-format " #{E:@carriot_badge}"

# prefix F: session picker popup. prefix b: jump to the session waiting on you the longest.
bind F display-popup -E -w 90% -h 80% "~/carriot/bin/carriot pick"
bind b run-shell "TMUX_PANE=#{pane_id} ~/carriot/bin/carriot next"

# prefix T: reins in its own window (reuses it if open). prefix G: cheatsheet.
bind T run-shell "tmux select-window -t '=reins' 2>/dev/null || tmux new-window -n reins '~/carriot/bin/carriot reins'"
bind G display-popup -E -w 90 -h 90% "~/carriot/bin/carriot help | less -R"

# prefix P: park the agent in the current pane (or detach from a background session); it keeps running.
bind P run-shell "TMUX_PANE=#{pane_id} ~/carriot/bin/carriot park"

# prefix A: new agent window running claude --dangerously-skip-permissions (from the carriot root).
bind A run-shell "TMUX_PANE=#{pane_id} ~/carriot/bin/carriot new"

# prefix X: close the agent in the current pane and the pane itself (conversation stays resumable).
bind X confirm-before -p "close this agent and its pane? (y/n)" "run-shell 'TMUX_PANE=#{pane_id} ~/carriot/bin/carriot close'"

# prefix R: after a crash or reboot, reopen every session lost in the last day (claude --resume).
bind R confirm-before -p "resume every session lost in the last day? (y/n)" "run-shell 'TMUX_PANE=#{pane_id} ~/carriot/bin/carriot resume --lost'"

# After tmux-resurrect restores (including continuum's automatic restore when tmux starts), reopen every session
# lost in the last day into its restored window. Remove this line to resume by hand with prefix R instead.
set -g @resurrect-hook-post-restore-all "$HOME/carriot/bin/carriot resume --lost"
