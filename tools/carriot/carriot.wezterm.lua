-- carriot WezTerm shortcuts. Each one sends the tmux prefix + the carriot binding from carriot.tmux.
-- Load it from wezterm.lua after `config` is built:
--   local ok, carriot = pcall(dofile, os.getenv("HOME") .. "/carriot/tools/carriot/carriot.wezterm.lua")
--   if ok then carriot.apply(config, keys) end
local wezterm = require("wezterm")

local M = {}

local path = os.getenv("HOME") .. "/carriot/tools/carriot/carriot.wezterm.lua"

---@param config table the wezterm config table
---@param keys table the dotfiles keys helper (provides tmux_prefixed_key)
function M.apply(config, keys)
  wezterm.add_to_config_reload_watch_list(path)
  local bindings = {
    -- new agent window (claude --dangerously-skip-permissions), next to CMD+t for a plain window
    { mods = "CMD|SHIFT", key = "t", action = keys.tmux_prefixed_key({ mods = "SHIFT", key = "a" }) },
    -- jump to the session that has waited on you the longest
    { mods = "CMD", key = "b", action = keys.tmux_prefixed_key({ key = "b" }) },
    -- reins: every session, full screen
    { mods = "CMD|SHIFT", key = "a", action = keys.tmux_prefixed_key({ mods = "SHIFT", key = "t" }) },
    -- picker popup
    { mods = "CMD", key = "g", action = keys.tmux_prefixed_key({ mods = "SHIFT", key = "f" }) },
    -- park the current agent
    { mods = "CMD|SHIFT", key = "p", action = keys.tmux_prefixed_key({ mods = "SHIFT", key = "p" }) },
    -- close the current agent and its pane (tmux asks to confirm)
    { mods = "CMD|SHIFT", key = "w", action = keys.tmux_prefixed_key({ mods = "SHIFT", key = "x" }) },
    -- cheatsheet
    { mods = "CMD", key = "/", action = keys.tmux_prefixed_key({ mods = "SHIFT", key = "g" }) },
    -- dashboard on the current session (goes through tmux so carriot knows which pane you are in)
    { mods = "CMD|SHIFT", key = "o", action = keys.tmux_prefixed_key({ mods = "SHIFT", key = "o" }) },
  }
  config.keys = config.keys or {}
  for _, binding in ipairs(bindings) do
    table.insert(config.keys, binding)
  end
end

return M
