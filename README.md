# GENESIS

A local, single-user civilization sandbox. Observe three Iron Age societies, follow the lives shaping them, change reality, and trace the consequences through a permanent causal history.

## Open in a browser

A browser-only version needs no installed runtime or API key. It runs the same simulation with private IndexedDB saves, import/export, checkpoints, and alternate timelines. Build it with `npm run build:web`; `dist-web/index.html` contains the entire app, including fonts. It can be served by any static HTTPS host, or opened directly as an HTML file in browsers that support storage on local files. Browser storage belongs to the site/browser profile; export backups before clearing data or changing hosts.

`npm run preview:web` serves the static build locally for development. `node scripts/browser-web-smoke.mjs` verifies this build with real IndexedDB, UI interactions, downloads, reloads, direct-file execution, and no `/api` requests. The original Node/SQLite workflow remains available.

GitHub Pages deployment is prepared in `.github/workflows/pages.yml`. The repository needs Pages enabled under **Settings → Pages → Build and deployment → Source → GitHub Actions**, then a main-branch push or manual workflow run publishes the `dist-web` artifact. Workflow tokens can deploy an enabled site; they cannot reliably enable Pages on a new repository. The browser edition uses local deterministic agents and grounded local queries; server-only external AI assistance remains available in the Node edition.

## Run locally

Requires **Node.js 24 or later** (uses built-in SQLite).

```sh
npm ci
npm run dev
```

Open the Vite address shown in the terminal (default port 5173). The local engine runs on port 3001. An Erya / Three Kingdoms world is created on the first visit. No API key is required, and fonts and map graphics are bundled locally.

To start the prepared application and open your default browser automatically, run `npm run open`. On a fresh download it installs the locked dependencies if needed. Keep the terminal open while playing. This launcher runs on your own computer; the cloud onboarding screen has no interactive preview.

For production:

```sh
npm run build
npm start
```

The engine serves the built interface on port 3001. `PORT`, `HOST`, and `DATABASE_PATH` can override the defaults. Run commands from the repository root. In the Codex cloud machine use `npm ci --cache /workspace/.cache/npm` because the home npm cache is not writable.

## Play

- **Play** runs continuously; 1× / 5× / 25× / 100× advance 30 days / 6 months / 2 years / 10 years per 2.6-second interval. Choose pause criteria in World settings.
- **Advance time** accepts `1 day`, `17 days`, `3 months`, `47 years`, `12,000 years`, `2 million years`, `4.2 billion years`, compound durations, and conditions such as `until the king dies`, `until this war ends`, `until humans reach another continent`, and `until the next major historical event`. Event searches have a bounded observation window and report explicitly when nothing matches.
- **Intervene** previews structured changes, effects, targets, and assumptions. All interventions require Apply. Supported actions include disaster, disease, succession, personality, knowledge, technology, politics, religion, geography, population, relationships, new people, and custom phenomena. Unrecognized reality changes preserve the full request as canon with explicit supported-mechanics assumptions; they do not pretend to simulate arbitrary new physics.
- Click **regions, settlements, people, events, religions, and wars** to inspect real data. People hold separate, sometimes wrong perceptions. The event inspector links recorded parents and consequences rather than guessing at causality.
- **Ask the world** answers from state and recorded events. The command field routes durations, navigation, questions, and interventions.
- **World library** creates, renames, duplicates, deletes, exports, and imports universes. Changes autosave into `.local/genesis.sqlite`. Settings also has a manual save button. Browser local storage remembers the selected world only; actual simulation data lives in SQLite.
- **Snapshots & timelines** creates checkpoints and restores into a separate named world branch. Original worlds are preserved. Up to 30 checkpoints per world are retained, automatically before large skips, world-changing advances, and interventions. Permanent history inside each retained world is not truncated.
- **Developer vision** exposes decision scores, true/perceived knowledge, and raw events.

## Architecture

`src/simulation/` is the numerical source of truth. The seeded PRNG, aggregate populations, stock/demand prices, budgets, disease cases, wars, religions, research prerequisites, environments, and institutional changes are program logic. Daily, monthly, annual, multi-year, and epoch time resolutions keep huge skips bounded. Epochs summarize long intervals; they are not literal biological or astrophysical models. The Big Bang through civilization is a procedural milestone ledger before detailed play begins in Year 842.

`src/simulation/agents.ts` builds intentions from personalities, goals, relationships, memories, and perceived knowledge. The engine validates/executes decisions. Individual citizens are aggregate cohorts; roughly 30 consequential starting characters are simulated individually and successors/prominent commoners can emerge.

`src/simulation/interventions.ts` parses reality changes into validated operations and keeps canon persistent. Agent knowledge, fears, exploration, study, and religious interpretations can react to introduced phenomena later.

`server/` provides an Express API and transactional SQLite world/checkpoint storage. Import validation checks references, finite/nonnegative values, ledger order, and versions. Intervention previews are held server-side and bound to a digest of current state, preventing stale or altered proposals from changing a save.

`src/App.tsx` is the React observer interface; `src/components/WorldMap.tsx` draws seeded geography and actual layers as SVG. Population charts use recorded samples. Chronicle entries, source citations, and biographies use stored events.

## Optional external AI

Local deterministic agents and grounded queries work by default. Optional OpenAI-compatible query assistance uses server-side configuration:

```sh
GENESIS_AI_KEY=… GENESIS_AI_BASE_URL=https://api.openai.com/v1 GENESIS_AI_MODEL=gpt-4o-mini npm run dev
```

Server scripts also read an optional `.env` file; copy `.env.example` and fill only the settings you need. Keep credentials out of source control. This V1 asks the provider to select relevant **verified passages** using structured JSON; it never accepts freeform numerical state or lets remote output mutate the world. Invalid provider output or network errors fall back to local answers. External AI decision generation, invented negotiations, rich family-tree graph layouts, and timeline comparison are extension points, not claimed features.

## Validation

```sh
npm test          # Seeded engine invariants and real SQLite API integration
npm run build    # Strict TypeScript check and production build
node scripts/browser-smoke.mjs  # With npm run dev running
```

The browser test uses system Chromium (default `/usr/bin/chromium`, override `CHROMIUM_PATH`) and accepts `GENESIS_URL`. It creates and removes its own test worlds. It covers creation, map/character inspection, time advancement, preview/apply, canon, questions, branching, reload persistence, live mode, navigation, and mobile layout.

The V1 uses deliberately abstract economies, territories, species behaviors, and long epochs. Repeatable same-step seeded runs match. Different step resolutions preserve similar macro trends rather than identical stochastic histories. World schema version is currently 1; export JSON before removing the database or making future schema changes.
