# AGENTS.md

## Project purpose

`pise-en-place` is Seth's personal Pi extension package and should be treated as the source of truth for Pi workflow customizations in this repo. It contains project-owned extensions, themes, shared helpers, and documentation for Pi behavior such as safety confirmations, usage tracking, skill upkeep, status UI, PR helpers, markdown output, local sharing, session helpers, and roadmap writing.

When working in this repository, prefer adding or changing code here instead of creating global files under `~/.pi/agent/`. Global Pi locations are runtime/install targets, not the development source for this package.

## Where changes belong

- New Pi extensions belong under `extensions/<area>/`.
- Shared implementation used by multiple extensions belongs under `src/shared/`.
- Themes belong under `themes/`.
- Design notes and user-facing behavior documentation belong under `docs/`.
- Package registration belongs in the `pi` section of `package.json`.
- Runtime ledgers and local user data may live under `~/.pi/agent/`, but should not be committed or treated as source files.

If a change would normally be made as a global Pi extension, implement it in this package and register it in `package.json` instead. Only write to `~/.pi/agent/` when explicitly working with runtime data, installs, or user-specific settings.

## Pi package model

This repository is installed into Pi as a local package. From the repository root:

```bash
pi install .
```

For project-only use, install it into local project settings:

```bash
pi install -l .
```

Pi loads resources declared in `package.json` under the `pi` key. After changing extension code in an active Pi session, use Pi's `/reload` command.

## Development workflow

Before adding a new command, shortcut, tool, status UI, persistent file, or other user-facing surface, confirm the desired interface with Seth unless it was already specified.

When implementing Pi behavior:

1. Inspect nearby extensions for style and existing helpers.
2. Read the relevant Pi docs and examples when using unfamiliar APIs.
3. Add the extension file under `extensions/`.
4. Register it in `package.json` under `pi.extensions`.
5. Document user-facing behavior in `README.md` or `docs/` when appropriate.
6. Validate with `npm run validate` when practical.

## Commands

```bash
npm install
npm run typecheck
npm run test
npm run validate
```

## Coding conventions

- TypeScript, CommonJS package, Pi extension default exports.
- Prefer small focused extensions organized by workflow area.
- Keep prompt/session content out of ledgers unless explicitly requested.
- Prefer append-only JSONL for simple private runtime ledgers; migrate to SQLite only if needed.
- Use existing shared helpers before creating new utilities.
- Keep generated/runtime artifacts out of git.
