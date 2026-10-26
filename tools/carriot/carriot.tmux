# carriot tmux integration. Load it last from ~/.tmux.conf:
#   source-file -q ~/carriot/tools/carriot/carriot.tmux

# Append the state dot to whatever window formats the theme already set.
set -ga window-status-format " #{E:@carriot_badge}"
set -ga window-status-current-format " #{E:@carriot_badge}"

# prefix F: session picker popup. prefix b: jump to the session waiting on you the longest.
bind F display-popup -E -w 90% -h 80% "~/carriot/bin/carriot pick"
bind b run-shell "TMUX_PANE=#{pane_id} ~/carriot/bin/carriot next"

# prefix T: control tower in its own window (reuses it if open). prefix G: cheatsheet.
bind T run-shell "tmux select-window -t '=tower' 2>/dev/null || tmux new-window -n tower '~/carriot/bin/carriot tower'"
bind G display-popup -E -w 90 -h 90% "~/carriot/bin/carriot help | less -R"

# prefix P: park the agent in the current pane (or detach from a background session); it keeps running.
bind P run-shell "TMUX_PANE=#{pane_id} ~/carriot/bin/carriot park"

# prefix A: new agent window running claude --dangerously-skip-permissions (from the carriot root).
bind A run-shell "TMUX_PANE=#{pane_id} ~/carriot/bin/carriot new"

# prefix X: close the agent in the current pane and the pane itself (conversation stays resumable).
bind X confirm-before -p "close this agent and its pane? (y/n)" "run-shell 'TMUX_PANE=#{pane_id} ~/carriot/bin/carriot close'"
