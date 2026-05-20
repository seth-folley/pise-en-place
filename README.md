# pise-en-place

Personal Pi extension package for safety checks, usage tracking, status UI, skill upkeep, sharing helpers, and local workflow integrations.

## Install as a local Pi package

This repo is intended to be the source of truth for the extensions. Instead of symlinking `extensions/` into `~/.pi/agent/extensions`, install the repo as a local Pi package:

```bash
pi install /Users/sethfolley/Development/Personal/pise-en-place
```

Pi will add the local package path to `~/.pi/agent/settings.json` and load the resources declared in `package.json` under the `pi` key.

For project-only use, install it into project settings instead:

```bash
pi install -l /Users/sethfolley/Development/Personal/pise-en-place
```

## Structure

```text
extensions/
  safety/          dangerous operation confirmations
  usage/           token/cost ledger and /usage command
  skills/          skill read tracking and skill update flows
  ui/              status line, response timing, ask_user UI tool
  productivity/    local sharing, session helpers, roadmap writer
  integrations/    external integrations such as Supacode
src/shared/        shared implementation helpers used by extensions
docs/              design notes and user-facing docs
```

## Development

```bash
npm install
npm run typecheck
npm run test
npm run validate
```

Use Pi's `/reload` after changing extension code in an active session.

## Runtime data

Runtime ledgers and local Pi files are intentionally not committed. Usage and skill-read ledgers are written under `~/.pi/agent/` by the relevant extensions.
