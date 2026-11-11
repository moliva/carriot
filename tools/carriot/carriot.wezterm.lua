-- carriot WezTerm shortcuts. Each one sends the tmux prefix + the carriot binding from carriot.tmux.
-- Load it from wezterm.lua after `config` is built:
--   local ok, carriot = pcall(dofile, os.getenv("HOME") .. "/carriot/tools/carriot/carriot.wezterm.lua")
--   if ok then carriot.apply(config, keys) end
local wezterm = require("wezterm")

local M = {}

local path = os.getenv("HOME") .. "/carriot/tools/carriot/carriot.wezterm.lua"

-- Local, untracked rules: a list of { prefix = "https://...", profile = "Profile N" }, where profile is the
-- Chrome profile directory name. Read on every click, so edits apply without reloading WezTerm.
local profiles_path = os.getenv("HOME") .. "/.config/carriot/chrome-profiles.lua"

---@param uri string the clicked link
---@param rules table the { prefix, profile } rules, first match wins
---@return string|nil profile the Chrome profile directory for the link, or nil when no rule matches
function M.chrome_profile_for(uri, rules)
  for _, rule in ipairs(rules) do
    if rule.prefix and rule.prefix ~= "" and uri:sub(1, #rule.prefix) == rule.prefix then
      return rule.profile
    end
  end
  return nil
end

local function load_rules()
  local ok, rules = pcall(dofile, profiles_path)
  if ok and type(rules) == "table" then
    return rules
  end
  return {}
end

---@param config table the wezterm config table
---@param keys table the dotfiles keys helper (provides tmux_prefixed_key)
function M.apply(config, keys)
  wezterm.add_to_config_reload_watch_list(path)

  -- Links matching a rule open in that Chrome profile; everything else keeps WezTerm's default opener.
  wezterm.on("open-uri", function(_, _, uri)
    local profile = M.chrome_profile_for(uri, load_rules())
    if not profile then
      return
    end
    wezterm.background_child_process({
      "open", "-na", "Google Chrome", "--args", "--profile-directory=" .. profile, uri,
    })
    return false
  end)

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
